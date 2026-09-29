import { Param } from './param';
import { Workspace } from './workspace';
import { Task, TaskLike, TaskDef } from './task';
import type { StatusReporter } from './status-reporter';
import { TRIGGER_EVENTS } from './trigger-events';
import { triggerEvents } from './trigger';
import type { PipelineTrigger } from './trigger';
import { Condition } from './condition';
import { applyOverrides, unwrapGated, GatedTask } from './pipeline-task';
import type { TaskArtifact } from './artifact';
import { warmCacheLink } from './warm-cache';
import type { WarmCache } from './warm-cache';
import type { PipelineTaskOverrides } from './pipeline-task';

/**
 * The workspace name a `$(workspaces.<name>.path)`-rooted working directory refers to,
 * or `undefined` when the directory is absent or not workspace-relative.
 */
function workspaceOfPath(workingDir: unknown): string | undefined {
  if (typeof workingDir !== 'string') return undefined;
  return /^\$\(workspaces\.([^.)]+)\.path\)/.exec(workingDir)?.[1];
}

/** Options for constructing a {@link Pipeline}. */
export interface PipelineOptions {
  /**
   * Pipeline name. Auto-generated from the trigger event when omitted
   * (e.g. `"push-pipeline"` for a single-event trigger).
   */
  name?: string;
  /**
   * Firing config — when this pipeline runs (events, branches, paths, comment/label filters).
   * See {@link PipelineTrigger}. A pipeline without a `trigger` has nothing to fire it under
   * PAC, so the PAC target skips it; a plain-Tekton target emits it anyway.
   */
  trigger?: PipelineTrigger;
  /** Top-level tasks. Transitive dependencies are auto-discovered via `task.needs`. */
  tasks: TaskLike[];
  /** Tasks that run unconditionally after all regular tasks complete or fail. */
  finallyTasks?: TaskLike[];
  /** Additional pipeline-level params not tied to any specific task. */
  params?: Param[];
  /**
   * Overall PipelineRun timeout as a Go duration string (e.g. `"2h"`, `"90m"`).
   * Emitted by {@link TektonicProject} as `spec.timeouts.pipeline`. When unset, Tekton's
   * default (1h) applies — raise it for long pipelines (e.g. many image builds).
   */
  timeout?: string;
}

/**
 * A Tekton Pipeline definition.
 *
 * Automatically discovers all transitive task dependencies, infers the union of
 * params and workspaces from all tasks, validates the dependency graph, and
 * topologically sorts tasks for execution.
 */
export class Pipeline {
  readonly name: string;
  /** Firing config (events, branches, paths, …), compiled by whichever target emits the run. */
  readonly trigger?: PipelineTrigger;
  /** Trigger events associated with this pipeline (union of `trigger.rules[].on`). */
  readonly events: TRIGGER_EVENTS[];
  /** Top-level tasks provided at construction. */
  readonly tasks: TaskLike[];
  /** All tasks including transitive dependencies discovered via `task.needs`. */
  readonly allTasks: TaskLike[];
  /** Tasks that run unconditionally after all regular tasks complete or fail. */
  readonly finallyTasks: TaskLike[];
  /** Overall PipelineRun timeout (Go duration), emitted by TektonicProject. Unset = Tekton default. */
  readonly timeout?: string;
  private readonly extraParams: Param[];
  /**
   * Per-edge overrides contributed by `gated()` markers, keyed by the *unwrapped* task.
   * Markers are unwrapped before discovery so identity dedupes to one graph node; the
   * overrides they carried are applied here at spec-build time instead.
   */
  private readonly taskOverrides = new Map<TaskLike, PipelineTaskOverrides>();
  /**
   * Extra graph edges contributed by an overlay, keyed by the task they point into: the
   * producing tasks of a `gated()` override's {@link Condition}, and any `after` tasks a
   * scheduling primitive chained it behind. `TaskDef` wires the sources of its own `when`
   * into `needs`; an overlay cannot do that without mutating a task shared between
   * pipelines, so the pipeline carries the edge instead — these are discovered and become
   * `runAfter` entries exactly like `needs`.
   */
  private readonly overrideEdges = new Map<TaskLike, TaskLike[]>();
  /**
   * @internal Auto-generated tasks that set status contexts to pending at pipeline start —
   * one per distinct {@link StatusReporter} instance, keyed by that reporter, since a
   * reporter can only initialise the contexts it owns.
   */
  protected readonly _pendingTasks = new Map<StatusReporter, TaskDef>();

  private static _counter = 0;

  constructor(opts: PipelineOptions) {
    this.trigger = opts.trigger;
    this.events = opts.trigger ? triggerEvents(opts.trigger) : [];
    if (opts.name) {
      this.name = opts.name;
    } else if (this.events.length === 1) {
      this.name = `${this.events[0].replace('_', '-')}-pipeline`;
    } else {
      this.name = `pipeline-${Pipeline._counter++}`;
    }
    this.tasks = opts.tasks.map(t => this.registerOverrides(t));
    this.finallyTasks = (opts.finallyTasks ?? []).map(t => this.registerOverrides(t));
    this.timeout = opts.timeout;
    this.extraParams = opts.params ?? [];

    const regularTasks = this.discoverAllTasks(this.tasks);
    const statusTasks = regularTasks.filter(
      (t): t is TaskDef => t instanceof TaskDef && !!t.statusContext && !!t.statusReporter,
    );

    if (statusTasks.length > 0) {
      // Group by equivalent reporter: a pending task is built by one reporter and can only
      // initialise contexts that reporter owns. A pipeline mixing, say, a GitHub reporter
      // with a Slack one used to report every context through whichever was discovered
      // first. Two instances of the same class with equal pendingGroupKey() build identical
      // pending and reconciler tasks — they differ only in finalStep (failOnError) — so they
      // share one group; without a key, every instance is its own group.
      const groups: { reporter: StatusReporter; members: Set<StatusReporter>; tasks: TaskDef[] }[] = [];
      for (const task of statusTasks) {
        const reporter = task.statusReporter!;
        const key = reporter.pendingGroupKey?.();
        let group = groups.find(g => g.members.has(reporter)
          || (key !== undefined
            && g.reporter.constructor === reporter.constructor
            && g.reporter.pendingGroupKey?.() === key));
        if (!group) {
          group = { reporter, members: new Set(), tasks: [] };
          groups.push(group);
        }
        group.members.add(reporter);
        group.tasks.push(task);
      }

      const pendingTasks: TaskDef[] = [];
      let index = 0;
      for (const { reporter, members, tasks } of groups) {
        // The first (usual, single-reporter) group keeps the unsuffixed names, so a project
        // with one reporter emits exactly what it did before.
        const suffix = index === 0 ? '' : `-${index + 1}`;
        index++;
        const pending = reporter.createPendingTask(
          tasks.map(t => t.statusContext!),
          `set-status-pending-${this.name}${suffix}`,
        );
        for (const member of members) this._pendingTasks.set(member, pending);
        pendingTasks.push(pending);

        // A reporting task's own report-status step is its last step, so anything that stops
        // the task from reaching it leaves the context stuck on "pending" from the task
        // above: a `when` that skips the task, but equally an OOMKill, node eviction,
        // image-pull failure or TaskRun timeout, none of which are gated and none of which
        // run any step. Reconcile every reporting task in a `finally` task that runs after
        // the whole DAG.
        const reconcile = (reporter.createStatusReconcilerTask ?? reporter.createSkipResolverTask)?.bind(reporter);
        if (reconcile) {
          const entries = tasks.map(t => ({ taskName: t.name, context: t.statusContext! }));
          (this.finallyTasks as TaskLike[]).push(
            reconcile(entries, `reconcile-status-${this.name}${suffix}`),
          );
        }
      }
      this.allTasks = [...pendingTasks, ...regularTasks];
    } else {
      this.allTasks = regularTasks;
    }

    this.flagSharedWorkspaceCaches(regularTasks);
    this.validateArtifacts(regularTasks);
    this.validateWarmCaches(regularTasks);

    // Collect cache-save finally tasks from TaskDef nodes only.
    const cacheFinallyTasks = regularTasks
      .filter((t): t is TaskDef => t instanceof TaskDef)
      .flatMap(t => t.getCacheFinallyTasks());
    if (cacheFinallyTasks.length > 0) {
      (this.finallyTasks as TaskLike[]).push(...cacheFinallyTasks);
    }
  }

  /**
   * Flags caches whose restore would write into a workspace that more than one task in this
   * pipeline mounts. Tekton runs independent tasks concurrently, so a restore there lands on
   * a tree another task is actively using — the case that used to be a `rm -rf` of live files
   * and is now an atomic swap, but a swap that still discards work the other task just did.
   * Such caches default to `skipRestoreIfPathsExist`; an explicit setting always wins.
   */
  private flagSharedWorkspaceCaches(tasks: TaskLike[]): void {
    const mountCount = new Map<string, number>();
    for (const t of tasks) {
      for (const w of new Set(t.workspaces.map(w => w.name))) {
        mountCount.set(w, (mountCount.get(w) ?? 0) + 1);
      }
    }
    for (const task of tasks) {
      if (!(task instanceof TaskDef)) continue;
      for (const cache of task.caches) {
        if (cache.skipRestoreIfPathsExist !== undefined) continue;
        const target = workspaceOfPath(cache.workingDir ?? task.stepTemplate?.workingDir);
        if (!target || (mountCount.get(target) ?? 0) < 2) continue;
        task._markSharedWorkspaceCache(cache.name);
        // eslint-disable-next-line no-console
        console.warn(
          `tektonic [${this.name}/${task.name}]: cache '${cache.name}' restores into workspace ` +
            `'${target}', which ${mountCount.get(target)} tasks in this pipeline mount — ` +
            `defaulting to skipRestoreIfPathsExist so a concurrent task's warm tree is kept. ` +
            `Set skipRestoreIfPathsExist explicitly to silence this.`,
        );
      }
    }
  }

  /**
   * Checks every declared producer/consumer relationship for files.
   *
   * This is what `produces`/`consumes` are *for*: a consumer that names an artifact nothing
   * here publishes, or one whose producer is not ordered before it, is a runtime
   * file-not-found today and a synth-time error now. The two cases are reported separately —
   * "not in this pipeline" and "not ordered before you" are different mistakes with
   * different fixes, and conflating them sends the author looking in the wrong place.
   *
   * Publishing something nobody consumes only warns: an artifact left for a human to collect
   * is legitimate, and a pipeline that emits one is not broken.
   */
  private validateArtifacts(tasks: TaskLike[]): void {
    const inPipeline = new Set(tasks);
    const consumed = new Set<TaskArtifact>();
    const dependenciesClosure = this.dependenciesClosure();

    for (const task of tasks) {
      if (!(task instanceof TaskDef)) continue;
      for (const artifact of task.consumes) {
        consumed.add(artifact);
        if (!inPipeline.has(artifact.producer)) {
          throw new Error(
            `Pipeline '${this.name}': task '${task.name}' consumes artifact ` +
              `'${artifact.name}' from task '${artifact.producerName}', which is not in this ` +
              `pipeline — add '${artifact.producerName}' to it, or to '${task.name}'.needs`,
          );
        }
        if (artifact.producer === task) {
          throw new Error(
            `Pipeline '${this.name}': task '${task.name}' consumes its own artifact ` +
              `'${artifact.name}' — a task's own steps read the path directly`,
          );
        }
        if (!dependenciesClosure(task).has(artifact.producer)) {
          throw new Error(
            `Pipeline '${this.name}': task '${task.name}' consumes artifact ` +
              `'${artifact.name}', but its producer '${artifact.producerName}' is not ordered ` +
              `before it — add '${artifact.producerName}' to '${task.name}'.needs. ` +
              `Both tasks are in the pipeline; only the ordering is missing`,
          );
        }
      }
    }

    for (const task of tasks) {
      if (!(task instanceof TaskDef)) continue;
      for (const artifact of task.produces) {
        if (consumed.has(artifact)) continue;
        // eslint-disable-next-line no-console
        console.warn(
          `tektonic [${this.name}/${task.name}]: artifact '${artifact.name}' is declared but ` +
            `no task in this pipeline consumes it. That is fine for something a human ` +
            `collects; drop it from 'produces' if it is a leftover.`,
        );
      }
    }
  }

  /**
   * A memoized "every task this one transitively needs" lookup, for validators that ask
   * whether one task is ordered before another.
   */
  private dependenciesClosure(): (task: TaskLike) => Set<TaskLike> {
    const reachable = new Map<TaskLike, Set<TaskLike>>();
    const closure = (task: TaskLike): Set<TaskLike> => {
      const memo = reachable.get(task);
      if (memo) return memo;
      const acc = new Set<TaskLike>();
      reachable.set(task, acc);
      for (const dep of this.dependenciesOf(task)) {
        if (acc.has(dep)) continue;
        acc.add(dep);
        for (const t of closure(dep)) acc.add(t);
      }
      return acc;
    };
    return closure;
  }

  /**
   * Checks every {@link warmCache} declaration used in the pipeline: a consumer skips its
   * restore on the promise that the producer already populated the paths, and this is
   * where that promise is kept. A consumer whose producer is absent, ambiguous, or not
   * ordered before it would otherwise run cold — or restore mid-build under a concurrent
   * task — with nothing to say why.
   */
  private validateWarmCaches(tasks: TaskLike[]): void {
    const producers = new Map<WarmCache, TaskDef[]>();
    const consumers: Array<{ task: TaskDef; cache: WarmCache }> = [];
    for (const task of tasks) {
      if (!(task instanceof TaskDef)) continue;
      for (const spec of task.caches) {
        const link = warmCacheLink(spec);
        if (!link) continue;
        if (link.role === 'producer') {
          producers.set(link.cache, [...(producers.get(link.cache) ?? []), task]);
        } else {
          consumers.push({ task, cache: link.cache });
        }
      }
    }

    const dependenciesClosure = this.dependenciesClosure();
    for (const { task, cache } of consumers) {
      const found = producers.get(cache) ?? [];
      if (found.length === 0) {
        throw new Error(
          `Pipeline '${this.name}': task '${task.name}' consumes warm cache '${cache.name}', ` +
          `but no task in this pipeline declares its producer — add the task that ` +
          `declares '${cache.name}'.producer to '${task.name}'.needs`,
        );
      }
      if (found.length > 1) {
        throw new Error(
          `Pipeline '${this.name}': warm cache '${cache.name}' has more than one producer ` +
          `(${found.map(t => `'${t.name}'`).join(', ')}) — exactly one task may warm it`,
        );
      }
      const [producer] = found;
      if (producer === task) {
        throw new Error(
          `Pipeline '${this.name}': task '${task.name}' declares both the producer and a ` +
          `consumer of warm cache '${cache.name}' — use one`,
        );
      }
      if (!dependenciesClosure(task).has(producer)) {
        throw new Error(
          `Pipeline '${this.name}': task '${task.name}' consumes warm cache '${cache.name}', ` +
          `but its producer '${producer.name}' is not ordered before it — add ` +
          `'${producer.name}' to '${task.name}'.needs. The consumer skips restore when the ` +
          `paths exist, and only that ordering guarantees they do`,
        );
      }
    }
  }

  protected discoverAllTasks(tasks: TaskLike[]): TaskLike[] {
    const seen = new Set<TaskLike>();
    const visit = (node: TaskLike) => {
      const t = this.registerOverrides(node);
      if (seen.has(t)) return;
      seen.add(t);
      for (const dep of this.dependenciesOf(t)) visit(dep);
    };
    for (const t of tasks) visit(t);
    return [...seen];
  }

  /**
   * Records a `gated()` marker's overrides against the task it wraps and returns that task,
   * so the graph only ever holds unwrapped tasks and identity comparisons hold. Non-markers
   * pass through unchanged. Gating the same task twice in one pipeline is ambiguous, so it
   * throws rather than silently picking one set of overrides.
   */
  private registerOverrides(node: TaskLike): TaskLike {
    if (!(node instanceof GatedTask)) return node;
    const task = node.task;
    const existing = this.taskOverrides.get(task);
    if (existing && existing !== node._overrides) {
      throw new Error(
        `Pipeline '${this.name}': task '${task.name}' is gated more than once with different overrides`,
      );
    }
    this.taskOverrides.set(task, node._overrides);
    const edges = [
      ...(node._overrides.when instanceof Condition ? node._overrides.when.sources() : []),
      ...(node._overrides.after ?? []),
    ].map(unwrapGated);
    if (edges.length > 0) this.overrideEdges.set(task, edges);
    return task;
  }

  /**
   * Graph edges into `task`: its own `needs` plus any the pipeline's overlay adds — the
   * producing tasks of a `gated()` override condition, and `after` edges from a scheduling
   * primitive — none of which the task itself knows about.
   */
  private dependenciesOf(task: TaskLike): TaskLike[] {
    const needs = task.needs.map(unwrapGated);
    const extra = this.overrideEdges.get(task) ?? [];
    return [...needs, ...extra.filter(e => !needs.includes(e))];
  }

  /**
   * The `when` that will actually gate `task` in this pipeline: a `gated()` wrapper's override
   * replaces the task's own `when` for that pipeline edge, so it takes precedence when present.
   * Exposed for subclasses that need the effective gate without reaching into the overlay.
   */
  protected effectiveWhen(task: TaskDef): TaskDef['when'] {
    const overrides = this.taskOverrides.get(task);
    return overrides?.when !== undefined ? overrides.when : task.when;
  }

  /** @internal Emits one pipeline task entry, applying any `gated()` overrides for that task. */
  private toPipelineTaskSpec(task: TaskLike, runAfter: string[], namePrefix?: string): Record<string, unknown> {
    const spec = task._toPipelineTaskSpec(runAfter, namePrefix);
    const overrides = this.taskOverrides.get(task);
    return overrides ? applyOverrides(spec, overrides) : spec;
  }

  /** Returns the de-duplicated union of all task params plus any extra pipeline-level params. */
  inferParams(): Record<string, unknown>[] {
    const seen = new Map<string, Param>();
    for (const task of [...this.allTasks, ...this.finallyTasks]) {
      // A fan-out param is supplied per-element by the task's matrix, not by a
      // pipeline-level param, so exclude it from inference.
      const matrixParam = task instanceof TaskDef && task.fanOut ? task.fanOut.as.name : undefined;
      for (const p of task.params) {
        if (p.name === matrixParam) continue;
        if (!seen.has(p.name) && !p.pipelineExpression) seen.set(p.name, p);
      }
    }
    for (const p of this.extraParams) {
      if (!seen.has(p.name)) seen.set(p.name, p);
    }
    return [...seen.values()].map(p => p.toSpec());
  }

  /** Returns the de-duplicated union of all task workspaces. */
  inferWorkspaces(): Record<string, unknown>[] {
    const seen = new Map<string, Workspace>();
    for (const task of [...this.allTasks, ...this.finallyTasks]) {
      for (const w of task.workspaces) {
        if (!seen.has(w.name)) seen.set(w.name, w);
      }
    }
    return [...seen.values()].map(w => w.toSpec());
  }

  /**
   * @internal Returns the Pipeline spec as a plain object.
   *
   * {@link TektonicProject} calls this once per pipeline when it builds the `SynthModel`;
   * every synthesis target then emits the same spec — inlined into a PAC `PipelineRun`
   * template, or as the `spec` of a standalone `kind: Pipeline`.
   */
  _buildSpec(
    extraParams?: Record<string, unknown>[],
    namePrefix?: string,
  ): Record<string, unknown> {
    this.validate();
    const sorted = this.topoSort();
    return {
      params: this.deduplicateParams([...(extraParams ?? []), ...this.inferParams()]),
      workspaces: this.inferWorkspaces(),
      tasks: sorted.map(task =>
        this.toPipelineTaskSpec(task, this.runAfterFor(task), namePrefix),
      ),
      ...(this.finallyTasks.length > 0 && {
        finally: this.finallyTasks.map(task =>
          this.toPipelineTaskSpec(task, [], namePrefix),
        ),
      }),
    };
  }

  /**
   * Returns the `runAfter` task names for a given task within this pipeline.
   * Override in subclasses to inject additional ordering constraints.
   */
  protected runAfterFor(task: TaskLike): string[] {
    let names = this.dependenciesOf(task)
      .filter(dep => this.allTasks.includes(dep))
      .map(dep => dep.name);
    // A reporting task waits on the pending task built by *its own* reporter, so its context
    // is initialised before it can report.
    if (task instanceof TaskDef && task.statusContext && task.statusReporter) {
      const pending = this._pendingTasks.get(task.statusReporter);
      if (pending && pending !== task) names = [...names, pending.name];
    }
    return names;
  }

  private deduplicateParams(params: Record<string, unknown>[]): Record<string, unknown>[] {
    const seen = new Set<string>();
    return params.filter(p => {
      const name = p.name as string;
      if (seen.has(name)) return false;
      seen.add(name);
      return true;
    });
  }

  private validate(): void {
    const taskSet = new Set(this.allTasks);
    const nameSet = new Set<string>();

    for (const task of this.allTasks) {
      if (nameSet.has(task.name)) {
        throw new Error(
          `Pipeline '${this.name}': duplicate task name '${task.name}'`,
        );
      }
      nameSet.add(task.name);

      for (const dep of this.dependenciesOf(task)) {
        if (!taskSet.has(dep)) {
          throw new Error(
            `Pipeline '${this.name}': task '${task.name}' depends on '${dep.name}' which is not in the pipeline`,
          );
        }
      }
    }
  }

  private topoSort(): TaskLike[] {
    const visited = new Set<TaskLike>();
    const visiting = new Set<TaskLike>();
    const result: TaskLike[] = [];

    const visit = (task: TaskLike): void => {
      if (visited.has(task)) return;
      if (visiting.has(task)) {
        throw new Error(
          `Pipeline '${this.name}': cycle detected involving task '${task.name}'`,
        );
      }
      visiting.add(task);
      for (const dep of this.dependenciesOf(task)) {
        visit(dep);
      }
      visiting.delete(task);
      visited.add(task);
      result.push(task);
    };

    for (const task of this.allTasks) visit(task);
    return result;
  }
}
