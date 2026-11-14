import { describe, it, expect } from 'vitest';
import { App, Chart } from 'cdk8s';
import { pipelineManifest } from '../targets/tekton/tekton-target';
import { Pipeline } from './pipeline';
import { Task } from './task';
import { Param } from './param';
import { Result } from './result';
import { Workspace } from './workspace';
import { TRIGGER_EVENTS } from './trigger-events';
import { RecordingStatusReporter, TestStatusReporter } from '../../__fixtures__/reporter';
import { gated } from './pipeline-task';
import { onBranch } from './condition';

describe('Pipeline', () => {
  const workspace = new Workspace({ name: 'workspace' });
  const urlParam = new Param({ name: 'url' });
  const revParam = new Param({ name: 'revision' });
  const pathParam = new Param({ name: 'build-path', default: './' });

  const clone = new Task({
    name: 'clone',
    params: [urlParam, revParam],
    workspaces: [workspace],
    steps: [{ name: 'clone', image: 'git' }],
  });

  const test = new Task({
    name: 'test',
    params: [pathParam],
    workspaces: [workspace],
    needs: [clone],
    steps: [{ name: 'test', image: 'node' }],
  });

  const build = new Task({
    name: 'build',
    params: [pathParam],
    workspaces: [workspace],
    needs: [clone],
    steps: [{ name: 'build', image: 'node' }],
  });

  it('auto-discovers tasks from needs graph', () => {
    const pipeline = new Pipeline({ name: 'ci', tasks: [test] });
    expect(pipeline.allTasks).toContain(clone);
    expect(pipeline.allTasks).toContain(test);
    expect(pipeline.allTasks).toHaveLength(2);
  });

  it('deduplicates inferred params by name', () => {
    const pipeline = new Pipeline({ name: 'ci', tasks: [test, build] });
    const params = pipeline.inferParams();
    const names = params.map((p: any) => p.name);
    expect(names.filter((n: string) => n === 'build-path')).toHaveLength(1);
    expect(names).toContain('url');
    expect(names).toContain('revision');
    expect(names).toContain('build-path');
  });

  it('deduplicates inferred workspaces by name', () => {
    const pipeline = new Pipeline({ name: 'ci', tasks: [test, build] });
    const workspaces = pipeline.inferWorkspaces();
    expect(workspaces).toHaveLength(1);
    expect((workspaces[0] as any).name).toBe('workspace');
  });

  it('merges extra params with task-inferred params', () => {
    const extra = new Param({ name: 'extra' });
    const pipeline = new Pipeline({ name: 'ci', tasks: [test], params: [extra] });
    const params = pipeline.inferParams();
    const names = params.map((p: any) => p.name);
    expect(names).toContain('extra');
    expect(names).toContain('url');
  });

  it('names from single trigger', () => {
    const pipeline = new Pipeline({ trigger: { rules: [{ on: TRIGGER_EVENTS.PUSH }] }, tasks: [test] });
    expect(pipeline.name).toBe('push-pipeline');
  });

  it('throws on duplicate task names', () => {
    const dup = new Task({ name: 'clone', steps: [{ name: 's', image: 'alpine' }] });
    expect(() => {
      const p = new Pipeline({ name: 'bad', tasks: [clone, dup] });
      pipelineManifest(p, { namespace: 'ns' });
    }).toThrow(/duplicate task name/);
  });

  it('throws on cycle', () => {
    const a = new Task({ name: 'a', steps: [{ name: 's', image: 'alpine' }] });
    const b = new Task({ name: 'b', needs: [a], steps: [{ name: 's', image: 'alpine' }] });
    // Manually create a cycle by mutating (normally impossible via constructor)
    (a as any).needs = [b];
    expect(() => {
      const p = new Pipeline({ name: 'cycle', tasks: [a, b] });
      pipelineManifest(p, { namespace: 'ns' });
    }).toThrow(/cycle/);
  });

  it('pipelineManifest() produces valid Pipeline resource', () => {
    const pipeline = new Pipeline({ name: 'ci', tasks: [test, build] });
    const manifest = pipelineManifest(pipeline, { namespace: 'my-ns' }) as any;
    expect(manifest.apiVersion).toBe('tekton.dev/v1');
    expect(manifest.kind).toBe('Pipeline');
    expect(manifest.metadata.name).toBe('ci');
    expect(manifest.metadata.namespace).toBe('my-ns');

    // Tasks should include clone (auto-discovered), test, build
    const taskNames = manifest.spec.tasks.map((t: any) => t.name);
    expect(taskNames).toContain('clone');
    expect(taskNames).toContain('test');
    expect(taskNames).toContain('build');

    // test and build should runAfter clone
    const testTask = manifest.spec.tasks.find((t: any) => t.name === 'test');
    expect(testTask.runAfter).toEqual(['clone']);
    const buildTask = manifest.spec.tasks.find((t: any) => t.name === 'build');
    expect(buildTask.runAfter).toEqual(['clone']);

    // clone should have no runAfter
    const cloneTask = manifest.spec.tasks.find((t: any) => t.name === 'clone');
    expect(cloneTask.runAfter).toBeUndefined();
  });

  it('pipelineManifest() applies namePrefix', () => {
    const pipeline = new Pipeline({ name: 'ci', tasks: [test] });
    const manifest = pipelineManifest(pipeline, { namespace: 'ns', extraParams: [], namePrefix: 'myapp' }) as any;
    expect(manifest.metadata.name).toBe('myapp-ci');
    // taskRefs should also be prefixed
    const cloneTask = manifest.spec.tasks.find((t: any) => t.name === 'clone');
    expect(cloneTask.taskRef.name).toBe('myapp-clone');
  });

  it('includes finally tasks in inferParams and inferWorkspaces', () => {
    const statusParam = new Param({ name: 'status-param' });
    const statusWorkspace = new Workspace({ name: 'status-ws' });
    const statusTask = new Task({
      name: 'status',
      params: [statusParam],
      workspaces: [statusWorkspace],
      steps: [{ name: 'report', image: 'alpine' }],
    });
    const pipeline = new Pipeline({
      name: 'ci',
      tasks: [test],
      finallyTasks: [statusTask],
    });
    const paramNames = pipeline.inferParams().map((p: any) => p.name);
    expect(paramNames).toContain('status-param');
    expect(paramNames).toContain('url'); // from regular tasks
    const wsNames = pipeline.inferWorkspaces().map((w: any) => w.name);
    expect(wsNames).toContain('status-ws');
    expect(wsNames).toContain('workspace');
  });

  it('pipelineManifest() produces finally block in Pipeline spec', () => {
    const finalTask = new Task({
      name: 'final',
      steps: [{ name: 'done', image: 'alpine' }],
    });
    const pipeline = new Pipeline({
      name: 'ci',
      tasks: [test],
      finallyTasks: [finalTask],
    });
    const manifest = pipelineManifest(pipeline, { namespace: 'ns' }) as any;
    expect(manifest.spec.finally).toHaveLength(1);
    expect(manifest.spec.finally[0].name).toBe('final');
    // finally tasks should not have runAfter
    expect(manifest.spec.finally[0].runAfter).toBeUndefined();
  });

  it('tasks without statusReporter do not get runAfter set-status-pending', () => {
    const reporter = new TestStatusReporter();
    const reportingTask = new Task({
      name: 'test',
      statusReporter: reporter,
      steps: [{ name: 's', image: 'alpine', onError: 'continue' }],
    });
    const plainTask = new Task({
      name: 'lint',
      steps: [{ name: 's', image: 'alpine' }],
    });
    const pipeline = new Pipeline({ name: 'ci', tasks: [reportingTask, plainTask] });
    const manifest = pipelineManifest(pipeline, { namespace: 'ns' }) as any;
    const lintSpec = manifest.spec.tasks.find((t: any) => t.name === 'lint');
    // lint has no statusReporter — must not depend on set-status-pending
    expect(lintSpec.runAfter).toBeUndefined();
    // reporting task should depend on the pipeline-scoped pending task
    const testSpec = manifest.spec.tasks.find((t: any) => t.name === 'test');
    expect(testSpec.runAfter).toContain('set-status-pending-ci');
  });

  it('pending task name is scoped per pipeline so multi-pipeline projects do not collide', () => {
    const reporter = new TestStatusReporter();
    const mk = (name: string) =>
      new Task({ name, statusReporter: reporter, steps: [{ name: 's', image: 'alpine', onError: 'continue' }] });
    // Distinct task instances per pipeline (shared instances can't span pipelines via needs).
    const push = new Pipeline({ name: 'push', tasks: [mk('build'), mk('publish')] });
    const pr = new Pipeline({ name: 'pull-request', tasks: [mk('build')] });
    const nameOf = (p: Pipeline) =>
      (pipelineManifest(p, { namespace: 'ns' }) as any).spec.tasks
        .map((t: any) => t.name)
        .find((n: string) => n.startsWith('set-status-pending'));
    expect(nameOf(push)).toBe('set-status-pending-push');
    expect(nameOf(pr)).toBe('set-status-pending-pull-request');
    expect(nameOf(push)).not.toBe(nameOf(pr));
  });

  it('a when-gated statusReporter task gets a status-reconciler finally task', () => {
    const reporter = new TestStatusReporter();
    const reportingTask = new Task({
      name: 'deploy',
      statusReporter: reporter,
      when: onBranch('main'),
      steps: [{ name: 's', image: 'alpine', onError: 'continue' }],
    });
    const pipeline = new Pipeline({ name: 'ci', tasks: [reportingTask] });
    const manifest = pipelineManifest(pipeline, { namespace: 'ns' }) as any;
    const finallyTasks = manifest.spec.finally ?? [];
    expect(finallyTasks.find((t: any) => t.name === 'reconcile-status-ci')).toBeDefined();
    // finally tasks are not chained via runAfter — they always run after the whole DAG.
    expect(finallyTasks.find((t: any) => t.name === 'reconcile-status-ci').runAfter).toBeUndefined();
    // The gated task's status must reach the resolver as a param — the only scope where
    // Tekton substitutes $(tasks.*). Inlined in the step script it stays literal.
    expect(finallyTasks.find((t: any) => t.name === 'reconcile-status-ci').params)
      .toContainEqual({ name: 'status-deploy', value: '$(tasks.deploy.status)' });
    // ...and it must not leak into the pipeline's own params, which the PipelineRun supplies.
    expect(manifest.spec.params.map((p: any) => p.name)).not.toContain('status-deploy');
  });

  it('gated() override with when also gets a status-reconciler finally task', () => {
    const reporter = new TestStatusReporter();
    const reportingTask = new Task({
      name: 'publish',
      statusReporter: reporter,
      steps: [{ name: 's', image: 'alpine', onError: 'continue' }],
    });
    const pipeline = new Pipeline({
      name: 'ci',
      tasks: [gated(reportingTask, { when: onBranch('main') })],
    });
    const manifest = pipelineManifest(pipeline, { namespace: 'ns' }) as any;
    const finallyTasks = manifest.spec.finally ?? [];
    expect(finallyTasks.find((t: any) => t.name === 'reconcile-status-ci')).toBeDefined();
  });

  // An ungated task cannot be skipped, but it can still be OOMKilled, evicted or timed out
  // before it reaches its own report-status step — leaving the context pending forever.
  it('an ungated statusReporter task is reconciled too', () => {
    const reporter = new TestStatusReporter();
    const reportingTask = new Task({
      name: 'test-ungated',
      statusReporter: reporter,
      steps: [{ name: 's', image: 'alpine', onError: 'continue' }],
    });
    const pipeline = new Pipeline({ name: 'ci', tasks: [reportingTask] });
    const manifest = pipelineManifest(pipeline, { namespace: 'ns' }) as any;
    const reconciler = (manifest.spec.finally ?? []).find((t: any) => t.name === 'reconcile-status-ci');
    expect(reconciler).toBeDefined();
    expect(reconciler.params).toContainEqual({ name: 'status-test-ungated', value: '$(tasks.test-ungated.status)' });
  });

  it('reconciles every reporting task in the pipeline, gated or not', () => {
    const reporter = new TestStatusReporter();
    const mkTask = (name: string, when?: ReturnType<typeof onBranch>) => new Task({
      name,
      statusReporter: reporter,
      ...(when && { when }),
      steps: [{ name: 's', image: 'alpine', onError: 'continue' }],
    });
    const pipeline = new Pipeline({
      name: 'ci',
      tasks: [mkTask('plain'), mkTask('guarded', onBranch('main'))],
    });
    const manifest = pipelineManifest(pipeline, { namespace: 'ns' }) as any;
    const reconciler = (manifest.spec.finally ?? []).find((t: any) => t.name === 'reconcile-status-ci');
    expect(reconciler.params.map((p: any) => p.name)).toEqual(
      expect.arrayContaining(['status-plain', 'status-guarded']),
    );
  });

  it('pipelineManifest() omits finally when no finally tasks', () => {
    const pipeline = new Pipeline({ name: 'ci', tasks: [test] });
    const manifest = pipelineManifest(pipeline, { namespace: 'ns' }) as any;
    expect(manifest.spec.finally).toBeUndefined();
  });

  it('pipelineManifest() includes extra params', () => {
    const pipeline = new Pipeline({ name: 'ci', tasks: [test] });
    const manifest = pipelineManifest(pipeline, { namespace: 'ns', extraParams: [{ name: 'project-name', type: 'string' }] }) as any;
    const paramNames = manifest.spec.params.map((p: any) => p.name);
    expect(paramNames).toContain('project-name');
    expect(paramNames).toContain('url');
  });

  describe('fan-out', () => {
    const buildFanoutPipeline = () => {
      const targets = new Result({ name: 'targets', type: 'array' });
      const detect = new Task({
        name: 'detect',
        results: [targets],
        steps: [{ name: 'd', image: 'alpine' }],
      });
      const service = new Param({ name: 'service' });
      const deploy = new Task({
        name: 'deploy',
        params: [service],
        fanOut: { over: targets, as: service },
        steps: [{ name: 's', image: 'alpine' }],
      });
      return { targets, detect, service, deploy };
    };

    it('excludes the fan-out param from pipeline-level inference', () => {
      const { deploy } = buildFanoutPipeline();
      const pipeline = new Pipeline({ name: 'ci', tasks: [deploy] });
      expect(pipeline.inferParams().map((p: any) => p.name)).not.toContain('service');
    });

    it('auto-discovers the producing task and emits matrix + runAfter', () => {
      const { deploy } = buildFanoutPipeline();
      const pipeline = new Pipeline({ name: 'ci', tasks: [deploy] });
      const manifest = pipelineManifest(pipeline, { namespace: 'ns' }) as any;

      const deployEntry = manifest.spec.tasks.find((t: any) => t.name === 'deploy');
      expect(deployEntry.matrix).toEqual({
        params: [{ name: 'service', value: '$(tasks.detect.results.targets[*])' }],
      });
      expect(deployEntry.runAfter).toContain('detect');
      // producing task auto-discovered though only reachable via the fan-out edge
      expect(manifest.spec.tasks.map((t: any) => t.name)).toContain('detect');
    });

    it('keeps the matrixed param on the produced Task manifest (synth vs. inference)', () => {
      const { deploy } = buildFanoutPipeline();
      const app = new App();
      const chart = new Chart(app, 't');
      deploy.synth(chart, 'ns');
      const taskManifest = chart.toJson()[0] as any;
      expect(taskManifest.spec.params.map((p: any) => p.name)).toContain('service');
    });
  });
});

describe('multiple status reporters', () => {
  const reportingTask = (name: string, reporter: TestStatusReporter) =>
    new Task({ name, statusReporter: reporter, steps: [{ name: 's', image: 'alpine' }] });

  const specOf = (pipeline: Pipeline) => (pipelineManifest(pipeline, { namespace: 'ns' }) as any).spec;

  // Two reporters whose pending/reconciler tasks differ — here by image; two different
  // implementations (GitHub and, say, Slack) would post to different systems entirely.
  const split = () => {
    const main = new TestStatusReporter();
    const other = new TestStatusReporter({ image: 'other' });
    return specOf(
      new Pipeline({ name: 'ci', tasks: [reportingTask('build', main), reportingTask('scan', other)] }),
    );
  };

  it('emits one pending task per reporter group', () => {
    const names = (split().tasks as any[]).map(t => t.name);
    expect(names).toContain('set-status-pending-ci');
    expect(names).toContain('set-status-pending-ci-2');
  });

  it('initialises each context through its own reporter and waits on that pending task', () => {
    const tasks = split().tasks as any[];
    expect(tasks.find(t => t.name === 'build').runAfter).toEqual(['set-status-pending-ci']);
    expect(tasks.find(t => t.name === 'scan').runAfter).toEqual(['set-status-pending-ci-2']);
  });

  it('reconciles each reporter group separately', () => {
    const spec = split();
    const finallyNames = (spec.finally as any[]).map(t => t.name);
    expect(finallyNames).toContain('reconcile-status-ci');
    expect(finallyNames).toContain('reconcile-status-ci-2');
    const first = (spec.finally as any[]).find(t => t.name === 'reconcile-status-ci');
    expect(first.params.map((p: any) => p.name)).toContain('status-build');
    expect(first.params.map((p: any) => p.name)).not.toContain('status-scan');
  });

  describe('reporters differing only in final-step behaviour', () => {
    // An explicit image, so synthesising a task needs no project injected-step image.
    const strict = new TestStatusReporter({ image: 'nu' });
    const reportOnly = new TestStatusReporter({ image: 'nu', failOnError: false });
    const build = reportingTask('build', strict);
    const scan = reportingTask('scan', reportOnly);
    const spec = specOf(new Pipeline({ name: 'ci', tasks: [build, scan] }));

    it('share one pending task', () => {
      const names = (spec.tasks as any[]).map(t => t.name);
      expect(names.filter((n: string) => n.startsWith('set-status-pending'))).toEqual(['set-status-pending-ci']);
      const tasks = spec.tasks as any[];
      expect(tasks.find(t => t.name === 'build').runAfter).toEqual(['set-status-pending-ci']);
      expect(tasks.find(t => t.name === 'scan').runAfter).toEqual(['set-status-pending-ci']);
    });

    it('share one reconciler covering both tasks', () => {
      expect((spec.finally as any[]).map(t => t.name)).toEqual(['reconcile-status-ci']);
      const params = (spec.finally as any[])[0].params.map((p: any) => p.name);
      expect(params).toContain('status-build');
      expect(params).toContain('status-scan');
    });

    it('still take their final step from their own reporter', () => {
      const finalScript = (task: Task) => {
        const chart = new Chart(new App(), 't');
        task.synth(chart, 'ns');
        const steps = (chart.toJson()[0] as any).spec.steps as any[];
        return steps.find(s => s.name === 'report-status').script as string;
      };
      expect(finalScript(build)).toContain('exit $exit_code');
      expect(finalScript(scan)).toContain('exit 0');
    });
  });

  it('keeps one group per instance for a reporter without pendingGroupKey', () => {
    // An external reporter written before pendingGroupKey existed.
    const keyless = () => Object.assign(new TestStatusReporter(), { pendingGroupKey: undefined });
    const spec = specOf(
      new Pipeline({ name: 'ci', tasks: [reportingTask('build', keyless()), reportingTask('scan', keyless())] }),
    );
    const names = (spec.tasks as any[]).map(t => t.name);
    expect(names).toContain('set-status-pending-ci');
    expect(names).toContain('set-status-pending-ci-2');
  });

  it('leaves the single-reporter case byte-identical', () => {
    const reporter = new TestStatusReporter();
    const spec = specOf(
      new Pipeline({ name: 'ci', tasks: [reportingTask('build', reporter), reportingTask('scan', reporter)] }),
    );
    const names = (spec.tasks as any[]).map(t => t.name);
    expect(names.filter((n: string) => n.startsWith('set-status-pending'))).toEqual(['set-status-pending-ci']);
    expect((spec.finally as any[]).map(t => t.name)).toEqual(['reconcile-status-ci']);
  });
});

describe('pending-task results', () => {
  const reportingTask = (name: string, reporter: TestStatusReporter, params: Param[] = []) =>
    new Task({ name, statusReporter: reporter, params, steps: [{ name: 's', image: 'alpine' }] });
  const specOf = (pipeline: Pipeline) => (pipelineManifest(pipeline, { namespace: 'ns' }) as any).spec;
  const paramOf = (spec: any, task: string, param: string) =>
    (spec.tasks as any[]).find(t => t.name === task).params.find((p: any) => p.name === param)?.value;

  it("binds each task's param to its own result on the pipeline's pending task", () => {
    const reporter = new RecordingStatusReporter();
    const spec = specOf(
      new Pipeline({ name: 'ci', tasks: [reportingTask('build', reporter), reportingTask('scan', reporter)] }),
    );
    expect(paramOf(spec, 'build', 'record-id')).toBe('$(tasks.set-status-pending-ci.results.record-build)');
    expect(paramOf(spec, 'scan', 'record-id')).toBe('$(tasks.set-status-pending-ci.results.record-scan)');
  });

  it('resolves against each pipeline sharing the task', () => {
    const reporter = new RecordingStatusReporter();
    const build = reportingTask('build', reporter);
    expect(paramOf(specOf(new Pipeline({ name: 'push', tasks: [build] })), 'build', 'record-id'))
      .toBe('$(tasks.set-status-pending-push.results.record-build)');
    expect(paramOf(specOf(new Pipeline({ name: 'pr', tasks: [build] })), 'build', 'record-id'))
      .toBe('$(tasks.set-status-pending-pr.results.record-build)');
  });

  it("uses a second reporter group's own pending task", () => {
    const spec = specOf(
      new Pipeline({
        name: 'ci',
        tasks: [
          reportingTask('build', new RecordingStatusReporter()),
          reportingTask('scan', new RecordingStatusReporter({ image: 'other' })),
        ],
      }),
    );
    expect(paramOf(spec, 'scan', 'record-id')).toBe('$(tasks.set-status-pending-ci-2.results.record-scan)');
  });

  it('declares the param on the task and not on the pipeline', () => {
    const build = reportingTask('build', new RecordingStatusReporter({ image: 'nu' }));
    const spec = specOf(new Pipeline({ name: 'ci', tasks: [build] }));
    expect((spec.params as any[]).map(p => p.name)).not.toContain('record-id');
    const chart = new Chart(new App(), 't');
    build.synth(chart, 'ns');
    const taskParams = (chart.toJson()[0] as any).spec.params as any[];
    expect(taskParams.find(p => p.name === 'record-id')).toEqual({ name: 'record-id', type: 'string' });
  });

  it('passes the pending task name to the reconciler', () => {
    const reporter = new RecordingStatusReporter();
    new Pipeline({ name: 'ci', tasks: [reportingTask('build', reporter)] });
    expect(reporter.reconcilerEntries).toEqual([
      { taskName: 'build', context: 'build', pendingTaskName: 'set-status-pending-ci' },
    ]);
  });

  it('rejects a binding to a result the pending task does not declare', () => {
    const reporter = new RecordingStatusReporter({ omitResults: true });
    expect(() => new Pipeline({ name: 'ci', tasks: [reportingTask('build', reporter)] })).toThrow(
      /binds param 'record-id' to result 'record-build' of pending task 'set-status-pending-ci'/,
    );
  });

  it("rejects a binding that collides with the task's own param", () => {
    expect(() =>
      reportingTask('build', new RecordingStatusReporter(), [new Param({ name: 'record-id' })]),
    ).toThrow(/already has a param of that name/);
  });

  it('leaves a reporter without pendingTaskResults unchanged', () => {
    const spec = specOf(new Pipeline({ name: 'ci', tasks: [reportingTask('build', new TestStatusReporter())] }));
    expect((spec.tasks as any[]).find(t => t.name === 'build').params.map((p: any) => p.name))
      .toEqual(['repo-full-name', 'revision']);
  });
});
