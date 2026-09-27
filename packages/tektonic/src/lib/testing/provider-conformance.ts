import { Pipeline } from '../core/pipeline';
import { Task, TaskDef } from '../core/task';
import type { TaskCacheSpec, TaskStepSpec } from '../core/task';
import type { TaskLike } from '../core/task';
import { Workspace } from '../core/workspace';
import type { StatusReporter } from '../core/status-reporter';
import type { CacheBackend } from '../core/cache-backend';
import type { ArtifactStore } from '../core/artifact';
import type { InjectedStepImage } from '../core/injected-image';
import { sh } from '../script';
import { synthPipeline, synthTask, type PipelineView, type TaskView } from './index';
import type { ConformanceResult } from './language-conformance';

/**
 * Conformance suites for authors of a {@link StatusReporter}, {@link CacheBackend} or
 * {@link ArtifactStore} — anything plugged into core from another package.
 *
 * The type check core runs on every change (`scripts/api-compat.mjs`) proves a provider
 * written against the last release still *compiles*. It cannot see behaviour: a pending
 * task that no longer runs first, a step name that now collides with one core injects, an
 * injected image a provider's steps can no longer resolve. These suites drive an
 * implementation through core's own synthesis, the way a project using it would, and
 * assert what core relies on. They know nothing about any provider, so a provider's CI
 * can run them against `@tektonic-ci/core@next` and hear about a break before it ships:
 *
 * ```ts
 * import { assertStatusReporterConformance } from '@tektonic-ci/core/testing';
 *
 * it('conforms to the StatusReporter contract', () => {
 *   assertStatusReporterConformance(() => new SlackStatusReporter({ channel: '#ci' }), {
 *     // The image your users must configure: the reporter's steps need nushell.
 *     injectedStepImage: { image: 'ghcr.io/acme/ci:1', provides: ['sh', 'nushell'] },
 *   });
 * });
 * ```
 *
 * Each suite takes a factory rather than an instance, so a check can build a second one to
 * compare against. It throws on the first violation, naming the contract it broke, and
 * otherwise returns the checks it ran — framework-agnostic, like
 * {@link assertExitCodeContract}.
 */

/** Options shared by every provider conformance suite. */
export interface ProviderConformanceOptions {
  /**
   * The project-level `injectedStepImage` the provider's users are expected to set. Steps
   * that ask for a capability through `injectedImageRef(...)` resolve against it, and
   * synthesis fails when it lacks one — as it would in a real project. Defaults to core's
   * own default, which provides only `sh` and `git`.
   */
  injectedStepImage?: InjectedStepImage;
}

/** Step and task names reach Kubernetes as container and resource names. */
const DNS_LABEL = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/;

class ConformanceError extends Error {}

function fail(kind: string, what: string, detail: string): never {
  throw new ConformanceError(`${kind} ${what}: ${detail}`);
}

/** Runs `fn`, turning an exception from core's synthesis into a named conformance failure. */
function during<T>(kind: string, what: string, fn: () => T): T {
  try {
    return fn();
  } catch (err) {
    if (err instanceof ConformanceError) throw err;
    fail(kind, what, err instanceof Error ? err.message : String(err));
  }
}

function checkStep(kind: string, where: string, step: TaskStepSpec | undefined): TaskStepSpec {
  if (!step || typeof step !== 'object') fail(kind, `${where} returned no step`, String(step));
  if (typeof step.name !== 'string' || !DNS_LABEL.test(step.name) || step.name.length > 63) {
    fail(kind, `${where} returned an invalid step name`, `${JSON.stringify(step.name)} is not a DNS label`);
  }
  if (typeof step.image !== 'string' || !step.image.trim()) {
    fail(kind, `${where} returned a step with no image`, `step '${step.name}'`);
  }
  return step;
}

function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

const userStep = (name: string): TaskStepSpec => ({ name, image: 'docker.io/library/alpine:3', script: sh`true` });

// ─── StatusReporter ─────────────────────────────────────────────────────────────

/**
 * Asserts a {@link StatusReporter} satisfies what core's synthesis relies on:
 *
 * - `createPendingTask` returns a task under the name core asks for, carrying every
 *   context, and core can wire it ahead of every reporting task.
 * - `finalStep` is a valid step, named apart from the step names projects commonly use,
 *   and it synthesizes as the task's last step.
 * - `requiredParams` reach every reporting task.
 * - A reconciler, if implemented, is named as asked, lands in `finally`, and reads
 *   `$(tasks.<name>.status)` for every reporting task.
 * - `pendingGroupKey`, if implemented, is stable, and two reporters built alike share one
 *   pending task.
 * - The whole pipeline synthesizes, twice, to the same output.
 */
export function assertStatusReporterConformance(
  factory: () => StatusReporter,
  opts: ProviderConformanceOptions = {},
): ConformanceResult {
  const kind = 'StatusReporter';
  const checks: string[] = [];
  const synth = { injectedStepImage: opts.injectedStepImage };
  const reporter = factory();

  if (!Array.isArray(reporter.requiredParams)) fail(kind, 'requiredParams', 'must be an array');
  const paramNames = reporter.requiredParams.map(p => p.name);
  if (new Set(paramNames).size !== paramNames.length) {
    fail(kind, 'requiredParams has duplicate names', paramNames.join(', '));
  }
  checks.push('requiredParams is a list of uniquely named params');

  // The pending task, standalone.
  const contexts = ['conformance/build', 'conformance/test'];
  const pending = during(kind, 'createPendingTask threw', () =>
    reporter.createPendingTask(contexts, 'set-status-pending-conformance'),
  );
  if (pending?.name !== 'set-status-pending-conformance') {
    fail(
      kind,
      'createPendingTask ignored the name it was given',
      `asked for 'set-status-pending-conformance', got ${JSON.stringify(pending?.name)}. Core ` +
        `scopes the name per pipeline so a multi-pipeline project does not emit two tasks under one name.`,
    );
  }
  const pendingView = during(kind, 'pending task does not synthesize', () => synthTask(pending, synth));
  const pendingText = JSON.stringify(pendingView.manifest);
  for (const c of contexts) {
    if (!pendingText.includes(c)) fail(kind, 'pending task drops a context', `'${c}' appears nowhere in it`);
  }
  checks.push('createPendingTask uses the given name and carries every context');

  // The final step, standalone.
  // Core rejects a task whose steps include the final step's name, so a name a project
  // ordinarily gives its own steps would break ordinary tasks at synth time. A fixed name such
  // as `report-status` is fine; `build` is not.
  const userSteps = ['build', 'test', 'compile', 'lint', 'deploy'];
  const final = checkStep(kind, 'finalStep', during(kind, 'finalStep threw', () =>
    reporter.finalStep('conformance/build', userSteps),
  ));
  if (userSteps.includes(final.name)) {
    fail(
      kind,
      'finalStep may collide with a user step',
      `its step is named '${final.name}', a name projects commonly give their own steps, and a ` +
        `task with a step of that name would fail to synthesize.`,
    );
  }
  checks.push('finalStep is a valid step, named apart from the user steps');
  if (!sameJson(final, reporter.finalStep('conformance/build', userSteps))) {
    fail(kind, 'finalStep is not deterministic', 'two calls with the same arguments differ, so `tektonic check` would always report drift');
  }
  checks.push('finalStep is deterministic');

  if (reporter.pendingGroupKey) {
    const key = reporter.pendingGroupKey();
    if (typeof key !== 'string') fail(kind, 'pendingGroupKey', `must return a string, got ${typeof key}`);
    if (key !== reporter.pendingGroupKey()) fail(kind, 'pendingGroupKey is not stable', 'two calls differ');
    if (key !== factory().pendingGroupKey?.()) {
      fail(kind, 'pendingGroupKey differs between two reporters built alike', 'they would get a pending task each');
    }
    checks.push('pendingGroupKey is stable across calls and across equal instances');
  }

  // Everything together, through a pipeline, the way a project uses it.
  const build = new Task({
    name: 'build',
    steps: [userStep('compile')],
    statusContext: 'conformance/build',
    statusReporter: reporter,
  });
  const test = new Task({
    name: 'test',
    needs: [build],
    steps: [userStep('unit')],
    statusContext: 'conformance/test',
    statusReporter: reporter.pendingGroupKey ? factory() : reporter,
  });
  const build1 = (): { view: PipelineView; tasks: Record<string, TaskView> } => {
    const pipeline = new Pipeline({ name: 'conformance', tasks: [test] });
    const view = synthPipeline(pipeline);
    const tasks: Record<string, TaskView> = {};
    for (const t of [...pipeline.allTasks, ...pipeline.finallyTasks] as TaskLike[]) {
      if (t instanceof TaskDef) tasks[t.name] = synthTask(t, synth);
    }
    return { view, tasks };
  };
  const first = during(kind, 'a pipeline using it does not synthesize', build1);
  const { view, tasks } = first;

  const pendingName = 'set-status-pending-conformance';
  if (!view.has(pendingName)) {
    fail(kind, 'pipeline has no single pending task', `expected '${pendingName}'; tasks: ${view.taskNames.join(', ')}`);
  }
  if (reporter.pendingGroupKey && view.has(`${pendingName}-2`)) {
    fail(kind, 'two reporters built alike got separate pending tasks', `'${pendingName}-2' was emitted`);
  }
  if (!view.runAfter('build').includes(pendingName)) {
    fail(kind, 'reporting task does not run after the pending task', `build runAfter: ${view.runAfter('build').join(', ') || '(none)'}`);
  }
  checks.push('one pending task, ahead of every reporting task');

  for (const name of ['build', 'test']) {
    const t = tasks[name];
    const last = t.stepNames[t.stepNames.length - 1];
    if (last !== final.name) {
      fail(kind, `final step is not last in '${name}'`, `steps: ${t.stepNames.join(', ')}`);
    }
    for (const p of paramNames) {
      if (!t.paramNames.includes(p)) fail(kind, `requiredParams '${p}' missing from '${name}'`, `params: ${t.paramNames.join(', ')}`);
    }
  }
  checks.push('final step runs last and requiredParams reach every reporting task');

  const reconcile = reporter.createStatusReconcilerTask ?? reporter.createSkipResolverTask;
  if (reconcile) {
    const name = 'reconcile-status-conformance';
    if (!view.finallyNames.includes(name)) {
      fail(kind, 'reconciler ignored the name it was given', `finally: ${view.finallyNames.join(', ') || '(none)'}`);
    }
    const text = JSON.stringify(view.task(name).raw) + JSON.stringify(tasks[name]?.manifest ?? {});
    for (const t of ['build', 'test']) {
      if (!text.includes(`$(tasks.${t}.status)`)) {
        fail(
          kind,
          'reconciler does not read a reporting task\'s status',
          `no '$(tasks.${t}.status)' in it, so a context left pending by a skipped or crashed '${t}' stays pending`,
        );
      }
    }
    checks.push('reconciler lands in finally and reads every reporting task\'s status');
  }

  const again = build1();
  if (!sameJson(first.view.spec, again.view.spec) || !sameJson(
    Object.fromEntries(Object.entries(first.tasks).map(([k, v]) => [k, v.manifest])),
    Object.fromEntries(Object.entries(again.tasks).map(([k, v]) => [k, v.manifest])),
  )) {
    fail(kind, 'synthesis is not deterministic', 'two syntheses of the same pipeline differ');
  }
  checks.push('pipeline synthesizes, and synthesizes identically twice');
  return { checks };
}

// ─── CacheBackend ───────────────────────────────────────────────────────────────

/**
 * Asserts a {@link CacheBackend} satisfies what core's synthesis relies on:
 *
 * - Restore and save are valid steps, named apart from each other and from those of a
 *   second cache on the same task.
 * - `spec.image` overrides the backend's own image, as the documented resolution order says.
 * - A task using it synthesizes with restore first and save last, and also with
 *   `saveStrategy: 'finally'`, where the save step runs in a pod of its own.
 * - Output is deterministic.
 */
export function assertCacheBackendConformance(
  factory: () => CacheBackend,
  opts: ProviderConformanceOptions = {},
): ConformanceResult {
  const kind = 'CacheBackend';
  const checks: string[] = [];
  const synth = { injectedStepImage: opts.injectedStepImage };
  const backend = factory();

  if (typeof backend.type !== 'string' || !backend.type.trim()) fail(kind, 'type', 'must be a non-empty string');
  if (typeof backend.needsPvcWorkspace !== 'boolean') fail(kind, 'needsPvcWorkspace', 'must be a boolean');
  checks.push('type and needsPvcWorkspace are set');

  const workspace = new Workspace({ name: 'source' });
  const spec = (name: string, extra: Partial<TaskCacheSpec> = {}): TaskCacheSpec => ({
    name,
    key: ['package-lock.json'],
    paths: ['node_modules'],
    workspace,
    backend: factory(),
    ...extra,
  });
  const ctx = { taskName: 'conformance', defaultImage: 'docker.io/library/alpine:3' };

  const steps = (s: TaskCacheSpec) => ({
    restore: checkStep(kind, 'restoreStep', during(kind, 'restoreStep threw', () => backend.restoreStep(s, ctx))),
    save: checkStep(kind, 'saveStep', during(kind, 'saveStep threw', () => backend.saveStep(s, ctx))),
  });
  const npm = steps(spec('npm'));
  const go = steps(spec('go'));
  const names = [npm.restore.name, npm.save.name, go.restore.name, go.save.name];
  if (new Set(names).size !== names.length) {
    fail(kind, 'step names collide', `two caches on one task produce steps ${names.join(', ')}. Derive them from spec.name.`);
  }
  checks.push('restore and save steps are valid and named per cache');

  const pinned = steps(spec('npm', { image: 'registry.example/pinned:1' }));
  for (const [which, s] of Object.entries(pinned)) {
    if (s.image !== 'registry.example/pinned:1') {
      fail(kind, `${which} step ignores spec.image`, `got '${s.image}'. spec.image must win over the backend's own default.`);
    }
  }
  checks.push('spec.image overrides the step image');

  if (!sameJson(npm, steps(spec('npm')))) fail(kind, 'steps are not deterministic', 'two calls with the same spec differ');
  checks.push('steps are deterministic');

  const task = (saveStrategy?: 'step' | 'finally') =>
    new Task({
      name: 'conformance',
      workspaces: [workspace],
      steps: [userStep('install')],
      caches: [spec('npm', saveStrategy ? { saveStrategy } : {})],
    });
  const view = during(kind, 'a task using it does not synthesize', () => synthTask(task(), synth));
  if (view.stepNames[0] !== npm.restore.name) fail(kind, 'restore step is not first', `steps: ${view.stepNames.join(', ')}`);
  if (view.stepNames[view.stepNames.length - 1] !== npm.save.name) {
    fail(kind, 'save step is not last', `steps: ${view.stepNames.join(', ')}`);
  }
  checks.push('a task synthesizes with restore first and save last');

  const deferred = task('finally');
  const finallyTasks = deferred.getCacheFinallyTasks();
  if (finallyTasks.length !== 1) fail(kind, "saveStrategy 'finally' produced no save task", `got ${finallyTasks.length}`);
  during(kind, "the 'finally' save task does not synthesize", () => {
    synthTask(deferred, synth);
    synthTask(finallyTasks[0], synth);
  });
  checks.push("saveStrategy 'finally' synthesizes a separate save task");
  return { checks };
}

// ─── ArtifactStore ──────────────────────────────────────────────────────────────

/**
 * Asserts an {@link ArtifactStore} satisfies what core's synthesis relies on:
 *
 * - `path` is absolute, or rooted at a workspace mount, and distinct per producer and per
 *   artifact, so each location has exactly one writer.
 * - Publish and fetch are valid steps, named apart across artifacts and producers.
 * - `uri`, if implemented, is a URI with a scheme.
 * - A producer and a consumer using it synthesize as a pipeline, with the publish step
 *   after the producer's steps and the fetch step before the consumer's.
 */
export function assertArtifactStoreConformance(
  factory: () => ArtifactStore,
  opts: ProviderConformanceOptions = {},
): ConformanceResult {
  const kind = 'ArtifactStore';
  const checks: string[] = [];
  const synth = { injectedStepImage: opts.injectedStepImage };
  const store = factory();

  if (typeof store.type !== 'string' || !store.type.trim()) fail(kind, 'type', 'must be a non-empty string');
  if (typeof store.needsWorkspace !== 'boolean') fail(kind, 'needsWorkspace', 'must be a boolean');
  checks.push('type and needsWorkspace are set');

  const workspace = new Workspace({ name: 'source' });
  const producer = (name: string) =>
    new Task({
      name,
      workspaces: [workspace],
      steps: [userStep('make')],
      produces: { dist: 'out/app.tar', report: 'out/report.json' },
      artifactStore: factory(),
    });
  const a = producer('build');
  const b = producer('package');
  const artifacts = [a.artifacts.dist, a.artifacts.report, b.artifacts.dist];

  const paths = artifacts.map(x => during(kind, 'path threw', () => store.path(x)));
  for (const p of paths) {
    // Relative to nothing in particular is the failure: a path is either absolute in the
    // container or rooted at a workspace mount, which is only known at run time.
    if (typeof p !== 'string' || !(p.startsWith('/') || /^\$\(workspaces\.[a-z0-9-]+\.path\)\//.test(p))) {
      fail(kind, 'path is not absolute', `${JSON.stringify(p)} is neither absolute nor rooted at $(workspaces.<name>.path)`);
    }
  }
  if (new Set(paths).size !== paths.length) {
    fail(kind, 'path is shared', `artifacts of different producers or names map to one location: ${paths.join(', ')}`);
  }
  if (!sameJson(paths, artifacts.map(x => store.path(x)))) fail(kind, 'path is not stable', 'two calls differ');
  checks.push('path is absolute, stable, and has one writer');

  const ctx = { taskName: 'conformance', defaultImage: 'docker.io/library/alpine:3' };
  const publish = artifacts.map(x =>
    checkStep(kind, 'publishStep', during(kind, 'publishStep threw', () => store.publishStep(x, ctx))),
  );
  const fetch = artifacts
    .map(x => during(kind, 'fetchStep threw', () => store.fetchStep(x, ctx)))
    .filter((s): s is TaskStepSpec => s !== undefined)
    .map(s => checkStep(kind, 'fetchStep', s));
  for (const [what, list] of [['publish', publish.slice(0, 2)], ['fetch', fetch]] as const) {
    const names = list.map(s => s.name);
    if (new Set(names).size !== names.length) {
      fail(kind, `${what} step names collide`, `${names.join(', ')}; one task can carry several of them`);
    }
  }
  checks.push('publish and fetch steps are valid and named per artifact');

  if (store.uri) {
    for (const x of artifacts) {
      const u = store.uri(x);
      if (typeof u !== 'string' || !/^[a-z][a-z0-9+.-]*:\/\//.test(u)) fail(kind, 'uri has no scheme', JSON.stringify(u));
    }
    checks.push('uri is a URI with a scheme');
  }

  const consumer = new Task({
    name: 'deploy',
    needs: [a, b],
    workspaces: [workspace],
    steps: [userStep('ship')],
    consumes: [a.artifacts.dist, b.artifacts.dist],
  });
  const pipeline = during(kind, 'a pipeline using it does not build', () =>
    new Pipeline({ name: 'conformance', tasks: [consumer] }),
  );
  during(kind, 'a pipeline using it does not synthesize', () => synthPipeline(pipeline));
  const made = during(kind, 'the producing task does not synthesize', () => synthTask(a, synth));
  const used = during(kind, 'the consuming task does not synthesize', () => synthTask(consumer, synth));
  const publishAt = made.stepNames.indexOf(publish[0].name);
  if (publishAt < made.stepNames.indexOf('make')) {
    fail(kind, 'publish step does not follow the producer\'s steps', `steps: ${made.stepNames.join(', ')}`);
  }
  const ownFetch = [store.fetchStep(a.artifacts.dist, ctx), store.fetchStep(b.artifacts.dist, ctx)];
  for (const s of ownFetch) {
    if (s && used.stepNames.indexOf(s.name) > used.stepNames.indexOf('ship')) {
      fail(kind, 'fetch step does not precede the consumer\'s steps', `steps: ${used.stepNames.join(', ')}`);
    }
  }
  checks.push('producer and consumer synthesize, publish after and fetch before the user steps');
  return { checks };
}
