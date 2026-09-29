import { describe, it, expect, vi, afterEach } from 'vitest';
import { App, Chart } from 'cdk8s';
import { Task } from './task';
import { Workspace } from './workspace';
import { Pipeline } from './pipeline';
import { taskPreset } from './task-preset';
import { warmCache } from './warm-cache';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyObj = Record<string, any>;

const CAPABLE = { injectedStepImage: 'ghcr.io/example/ci-base:test' } as const;

const synthSteps = (t: Task): AnyObj[] => {
  const app = new App();
  const chart = new Chart(app, 'test');
  t.synth(chart, 'ns', CAPABLE);
  return (chart.toJson()[0] as AnyObj).spec.steps;
};
const restoreScript = (t: Task): string =>
  synthSteps(t).find((s: AnyObj) => s.name.startsWith('restore-')).script;
const saveScript = (t: Task): string =>
  synthSteps(t).find((s: AnyObj) => s.name.startsWith('save-')).script;

const setup = () => {
  const ws = new Workspace({ name: 'workspace' });
  const cacheWs = new Workspace({ name: 'cache' });
  const go = warmCache({
    name: 'go',
    key: ['go.sum'],
    paths: ['.go-mod', '.go-build'],
    compress: true,
    workspace: cacheWs,
    workingDir: `$(workspaces.${ws.name}.path)`,
  });
  const task = (name: string, extra: Record<string, unknown> = {}) =>
    new Task({ name, workspaces: [ws], steps: [{ name: 's', image: 'go' }], ...extra });
  return { ws, go, task };
};

describe('warmCache', () => {
  afterEach(() => vi.restoreAllMocks());

  it('gives the producer the base spec and consumers skip-restore', () => {
    const { go } = setup();
    expect(go.name).toBe('go');
    expect(go.producer.skipRestoreIfPathsExist).toBeUndefined();
    expect(go.producer.forceSave).toBeUndefined();
    expect(go.consumer().skipRestoreIfPathsExist).toBe(true);
    expect(go.consumer().forceSave).toBeUndefined();
    expect(go.consumer({ forceSave: true }).forceSave).toBe(true);
    expect(go.consumer().paths).toEqual(['.go-mod', '.go-build']);
  });

  it('refuses a spec that sets skipRestoreIfPathsExist itself', () => {
    expect(() => warmCache({ name: 'go', key: [], paths: ['x'], skipRestoreIfPathsExist: true }))
      .toThrow(/skipRestoreIfPathsExist is set by the declaration/);
  });

  it('synthesizes skip-restore for consumers and force-save when asked', () => {
    const { go, task } = setup();
    const build = task('go-build', { caches: [go.producer] });
    const test = task('go-test', { needs: [build], caches: [go.consumer({ forceSave: true })] });
    const vuln = task('go-vulncheck', { needs: [build], caches: [go.consumer()] });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    new Pipeline({ name: 'ci', tasks: [test, vuln] });

    expect(restoreScript(test)).toContain('paths already exist, skipping restore');
    expect(restoreScript(vuln)).toContain('paths already exist, skipping restore');
    expect(saveScript(test)).not.toBe(saveScript(vuln));
    expect(JSON.stringify(synthSteps(test))).not.toContain('warmCache');
  });

  it('warns only for the producer on a shared workspace, not for ordered consumers', () => {
    const { go, task } = setup();
    const build = task('go-build', { caches: [go.producer] });
    const test = task('go-test', { needs: [build], caches: [go.consumer()] });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    new Pipeline({ name: 'ci', tasks: [test] });

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('[ci/go-build]'));
  });

  it('fails when no task in the pipeline declares the producer', () => {
    const { go, task } = setup();
    const test = task('go-test', { caches: [go.consumer()] });
    expect(() => new Pipeline({ name: 'ci', tasks: [test] }))
      .toThrow(/'go-test' consumes warm cache 'go', but no task in this pipeline declares its producer/);
  });

  it('fails when the producer is not ordered before the consumer', () => {
    const { go, task } = setup();
    const build = task('go-build', { caches: [go.producer] });
    const test = task('go-test', { caches: [go.consumer()] });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(() => new Pipeline({ name: 'ci', tasks: [build, test] }))
      .toThrow(/producer 'go-build' is not ordered before it — add 'go-build' to 'go-test'.needs/);
  });

  it('accepts a producer reached transitively', () => {
    const { go, task } = setup();
    const build = task('go-build', { caches: [go.producer] });
    const mid = task('lint', { needs: [build] });
    const test = task('go-test', { needs: [mid], caches: [go.consumer()] });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(() => new Pipeline({ name: 'ci', tasks: [test] })).not.toThrow();
  });

  it('fails when two tasks declare the producer', () => {
    const { go, task } = setup();
    const a = task('build-a', { caches: [go.producer] });
    const b = task('build-b', { needs: [a], caches: [go.producer] });
    const test = task('go-test', { needs: [b], caches: [go.consumer()] });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(() => new Pipeline({ name: 'ci', tasks: [test] }))
      .toThrow(/warm cache 'go' has more than one producer \(.*'build-a'.*\)/);
  });

  it('allows a producer with no consumers', () => {
    const { go, task } = setup();
    const build = task('go-build', { caches: [go.producer] });
    expect(() => new Pipeline({ name: 'ci', tasks: [build] })).not.toThrow();
  });

  it('keeps the link through a taskPreset', () => {
    const { ws, go } = setup();
    const preset = taskPreset({ workspaces: [ws], caches: [go.consumer()] });
    const build = preset({ name: 'go-build', steps: [{ name: 's', image: 'go' }] });
    const test = preset({ name: 'go-test', steps: [{ name: 's', image: 'go' }] });
    expect(() => new Pipeline({ name: 'ci', tasks: [build, test] }))
      .toThrow(/no task in this pipeline declares its producer/);
  });
});
