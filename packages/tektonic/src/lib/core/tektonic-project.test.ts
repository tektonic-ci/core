import { describe, it, expect, vi, afterEach } from 'vitest';
import { GitPipeline } from './git-pipeline';
import { Pipeline } from './pipeline';
import { Task } from './task';
import { Workspace } from './workspace';
import { TektonicProject } from './tektonic-project';
import { TRIGGER_EVENTS } from './trigger-events';

const capturedCharts: any[] = [];

vi.mock('cdk8s', async () => {
  const actual = await vi.importActual<typeof import('cdk8s')>('cdk8s');
  return {
    ...actual,
    App: class MockApp extends actual.App {
      synth() { /* no-op — suppress file writes in tests */ }
    },
    Chart: class CaptureChart extends actual.Chart {
      constructor(scope: any, id: string, props?: any) {
        super(scope, id, props);
        capturedCharts.push(this);
      }
    },
  };
});

describe('TektonicProject', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    capturedCharts.length = 0;
  });

  const buildTask = new Task({
    name: 'build',
    steps: [{ name: 'build', image: 'golang:1.24' }],
  });

  const testTask = new Task({
    name: 'test',
    needs: [buildTask],
    steps: [{ name: 'test', image: 'golang:1.24' }],
  });

  it('constructs without error for a push pipeline', () => {
    const pipeline = new GitPipeline({
      name: 'my-push',
      trigger: { rules: [{ on: TRIGGER_EVENTS.PUSH }] },
      tasks: [buildTask, testTask],
    });
    expect(() =>
      new TektonicProject({ namespace: 'ci', pipelines: [pipeline] }),
    ).not.toThrow();
  });

  it('constructs without error for push and PR pipelines', () => {
    const push = new GitPipeline({
      name: 'push',
      trigger: { rules: [{ on: TRIGGER_EVENTS.PUSH }] },
      tasks: [buildTask],
    });
    const pr = new GitPipeline({
      name: 'pull-request',
      trigger: { rules: [{ on: TRIGGER_EVENTS.PULL_REQUEST }] },
      tasks: [buildTask, testTask],
    });
    expect(() =>
      new TektonicProject({ namespace: 'ci', pipelines: [push, pr] }),
    ).not.toThrow();
  });

  it('constructs with name prefix', () => {
    const pipeline = new GitPipeline({
      name: 'push',
      trigger: { rules: [{ on: TRIGGER_EVENTS.PUSH }] },
      tasks: [buildTask],
    });
    expect(() =>
      new TektonicProject({ name: 'ocidex', namespace: 'ocidex-ci', pipelines: [pipeline] }),
    ).not.toThrow();
  });

  it('constructs with cache workspaces', () => {
    const goCache = new Workspace({ name: 'go-cache' });
    const pipeline = new GitPipeline({
      name: 'push',
      trigger: { rules: [{ on: TRIGGER_EVENTS.PUSH }] },
      tasks: [buildTask],
    });
    expect(() =>
      new TektonicProject({
        name: 'ocidex',
        namespace: 'ocidex-ci',
        pipelines: [pipeline],
        caches: [{ workspace: goCache, storageSize: '5Gi', storageClassName: 'local-path' }],
      }),
    ).not.toThrow();
  });

  it('skips pipelines with no triggers', () => {
    const noTrigger = new Pipeline({ name: 'manual', tasks: [buildTask] });
    expect(() =>
      new TektonicProject({ namespace: 'ci', pipelines: [noTrigger] }),
    ).not.toThrow();
  });

  it('constructs with tag trigger', () => {
    const tag = new GitPipeline({
      name: 'release',
      trigger: { rules: [{ on: TRIGGER_EVENTS.TAG }] },
      tasks: [buildTask],
    });
    expect(() =>
      new TektonicProject({ namespace: 'ci', pipelines: [tag] }),
    ).not.toThrow();
  });

  it('constructs with a custom target branch', () => {
    const pipeline = new GitPipeline({
      name: 'push',
      trigger: { rules: [{ on: TRIGGER_EVENTS.PUSH, branch: 'main' }] },
      tasks: [buildTask],
    });
    expect(() =>
      new TektonicProject({ namespace: 'ci', pipelines: [pipeline] }),
    ).not.toThrow();
  });

  it('constructs with custom pod security context', () => {
    const pipeline = new GitPipeline({
      name: 'push',
      trigger: { rules: [{ on: TRIGGER_EVENTS.PUSH }] },
      tasks: [buildTask],
    });
    expect(() =>
      new TektonicProject({
        namespace: 'ci',
        pipelines: [pipeline],
        defaultPodSecurityContext: { runAsUser: 1024, runAsGroup: 1024, fsGroup: 1024 },
      }),
    ).not.toThrow();
  });

  it('constructs with repoRelativePath override', () => {
    const pipeline = new GitPipeline({
      name: 'push',
      trigger: { rules: [{ on: TRIGGER_EVENTS.PUSH }] },
      tasks: [buildTask],
    });
    expect(() =>
      new TektonicProject({
        namespace: 'ci',
        pipelines: [pipeline],
        outdir: '../../.tekton',
        repoRelativePath: '.tekton',
      }),
    ).not.toThrow();
  });

  it('constructs with a glob target branch', () => {
    const pipeline = new GitPipeline({
      name: 'release',
      trigger: { rules: [{ on: TRIGGER_EVENTS.PUSH, branch: 'release/v*' }] },
      tasks: [buildTask],
    });
    expect(() =>
      new TektonicProject({ namespace: 'ci', pipelines: [pipeline] }),
    ).not.toThrow();
  });

  it('threads defaultImagePullPolicy into every synthesized task stepTemplate', () => {
    const pipeline = new GitPipeline({
      name: 'push',
      trigger: { rules: [{ on: TRIGGER_EVENTS.PUSH }] },
      tasks: [buildTask, testTask],
    });
    new TektonicProject({
      namespace: 'ci',
      pipelines: [pipeline],
      defaultImagePullPolicy: 'Always',
    });

    const tasks = capturedCharts
      .flatMap((c: any) => c.toJson())
      .filter((o: any) => o.kind === 'Task');
    expect(tasks.length).toBeGreaterThan(0);
    for (const t of tasks) {
      expect(t.spec.stepTemplate.imagePullPolicy).toBe('Always');
    }
  });

  it('merges pipelineRunAnnotations into the PipelineRun metadata alongside PAC annotations', () => {
    const pipeline = new GitPipeline({
      name: 'push',
      trigger: { rules: [{ on: TRIGGER_EVENTS.PUSH }] },
      tasks: [buildTask],
    });
    new TektonicProject({
      namespace: 'ci',
      pipelines: [pipeline],
      pipelineRunAnnotations: { 'chains.tekton.dev/transparency-upload': 'true' },
    });

    const allObjects = capturedCharts.flatMap((c: any) => c.toJson());
    const pipelineRun = allObjects.find((o: any) => o.kind === 'PipelineRun');
    expect(pipelineRun.metadata.annotations['chains.tekton.dev/transparency-upload']).toBe('true');
    // PAC annotations are preserved.
    expect(pipelineRun.metadata.annotations['pipelinesascode.tekton.dev/on-cel-expression']).toBeDefined();
  });

  it('emits spec.timeouts.pipeline when the pipeline sets a timeout', () => {
    const pipeline = new GitPipeline({
      name: 'push',
      trigger: { rules: [{ on: TRIGGER_EVENTS.PUSH }] },
      timeout: '2h',
      tasks: [buildTask],
    });
    new TektonicProject({ namespace: 'ci', pipelines: [pipeline] });
    const pipelineRun = capturedCharts.flatMap((c: any) => c.toJson()).find((o: any) => o.kind === 'PipelineRun');
    expect(pipelineRun.spec.timeouts).toEqual({ pipeline: '2h' });
  });

  it('omits spec.timeouts when no timeout is set', () => {
    const pipeline = new GitPipeline({ name: 'push', trigger: { rules: [{ on: TRIGGER_EVENTS.PUSH }] }, tasks: [buildTask] });
    new TektonicProject({ namespace: 'ci', pipelines: [pipeline] });
    const pipelineRun = capturedCharts.flatMap((c: any) => c.toJson()).find((o: any) => o.kind === 'PipelineRun');
    expect(pipelineRun.spec.timeouts).toBeUndefined();
  });

});

describe('Pipeline.events', () => {
  const t = () => new Task({ name: 't', steps: [{ name: 's', image: 'alpine' }] });

  it('is empty when no trigger is set', () => {
    expect(new Pipeline({ name: 'p', tasks: [t()] }).events).toEqual([]);
  });

  it('is the union of the trigger rules events', () => {
    const p = new Pipeline({
      name: 'p',
      tasks: [t()],
      trigger: {
        rules: [
          { on: TRIGGER_EVENTS.PUSH, branch: 'main' },
          { on: TRIGGER_EVENTS.PULL_REQUEST, branch: 'main' },
        ],
      },
    });
    expect(p.events).toEqual([TRIGGER_EVENTS.PUSH, TRIGGER_EVENTS.PULL_REQUEST]);
  });
});

describe('same-named tasks across pipelines', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    capturedCharts.length = 0;
  });

  const gitPipeline = (name: string, event: TRIGGER_EVENTS, opts: Record<string, unknown> = {}) =>
    new GitPipeline({
      name,
      trigger: { rules: [{ on: event }] },
      tasks: [new Task({ name: `work-${name}`, steps: [{ name: 's', image: 'alpine' }] })],
      ...opts,
    });

  // Each GitPipeline generates its own git-clone Task, but only one is emitted and all
  // pipelines reference it by name — so identical declarations must keep deduping silently.
  it('dedupes identical auto-generated git-clone tasks', () => {
    expect(
      () =>
        new TektonicProject({
          namespace: 'ci',
          pipelines: [gitPipeline('push', TRIGGER_EVENTS.PUSH), gitPipeline('pr', TRIGGER_EVENTS.PULL_REQUEST)],
        }),
    ).not.toThrow();
  });

  it('rejects two git-clone tasks that differ in cloneDepth', () => {
    expect(
      () =>
        new TektonicProject({
          namespace: 'ci',
          pipelines: [
            gitPipeline('push', TRIGGER_EVENTS.PUSH, { cloneDepth: 'full' }),
            gitPipeline('pr', TRIGGER_EVENTS.PULL_REQUEST),
          ],
        }),
    ).toThrow(/task 'git-clone' is declared differently in pipelines 'push' and 'pr'/);
  });

  it('names the differing fields and the manifest they collapse into', () => {
    let message = '';
    try {
      new TektonicProject({
        name: 'demo',
        namespace: 'ci',
        pipelines: [
          gitPipeline('push', TRIGGER_EVENTS.PUSH, { cloneImage: 'alpine/git:latest' }),
          gitPipeline('pr', TRIGGER_EVENTS.PULL_REQUEST),
        ],
      });
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain("single Task 'demo-git-clone'");
    expect(message).toContain('spec.steps[0].image');
  });

  it('rejects two user tasks that share a name but differ', () => {
    const a = new Task({ name: 'lint', steps: [{ name: 's', image: 'golangci-lint:1' }] });
    const b = new Task({ name: 'lint', steps: [{ name: 's', image: 'golangci-lint:2' }] });
    expect(
      () =>
        new TektonicProject({
          namespace: 'ci',
          pipelines: [
            new Pipeline({ name: 'push', trigger: { rules: [{ on: TRIGGER_EVENTS.PUSH }] }, tasks: [a] }),
            new Pipeline({ name: 'pr', trigger: { rules: [{ on: TRIGGER_EVENTS.PULL_REQUEST }] }, tasks: [b] }),
          ],
        }),
    ).toThrow(/task 'lint' is declared differently/);
  });
});
