import { describe, it, expect, vi, afterEach } from 'vitest';
import { App, Chart } from 'cdk8s';
import { Task } from '../core/task';
import { Workspace } from '../core/workspace';
import { Pipeline } from '../core/pipeline';
import { stagedExtract } from './shared';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyObj = Record<string, any>;

const source = () => new Workspace({ name: 'workspace' });
const store = () => new Workspace({ name: 'cache' });

// Every cache here is compressed, so the injected steps need nushell/tar/zstd: these tests
// name a project image the way a project does with `injectedStepImage`.
const CAPABLE = { injectedStepImage: 'ghcr.io/example/ci-base:test' } as const;

const restoreScript = (t: Task): string => {
  const app = new App();
  const chart = new Chart(app, 'test');
  t.synth(chart, 'ns', CAPABLE);
  return (chart.toJson()[0] as AnyObj).spec.steps.find((s: AnyObj) => s.name.startsWith('restore-')).script;
};

const goCache = (ws: Workspace, cacheWs: Workspace, extra: Record<string, unknown> = {}) => ({
  name: 'go',
  key: ['go.sum'],
  paths: ['.go-mod', '.go-build'],
  compress: true,
  workspace: cacheWs,
  workingDir: `$(workspaces.${ws.name}.path)`,
  ...extra,
});

describe('cache restore on a shared workspace', () => {
  afterEach(() => vi.restoreAllMocks());

  // The production failure this replaces: a restore rm -rf'd the module cache while another
  // task on the same workspace was compiling against it (ENOTEMPTY on the rm, "package
  // encoding/json is not in std" in the concurrent build).
  it('never deletes a cache path in place', () => {
    const ws = source();
    const t = new Task({
      name: 'go-test',
      workspaces: [ws],
      steps: [{ name: 's', image: 'go' }],
      caches: [goCache(ws, store())],
    });
    const script = restoreScript(t);
    expect(script).not.toContain('rm -rf $p');
    expect(script).toContain('mv $p $displaced');
    expect(script).toContain('mv $staged $p');
  });

  it('extracts into a staging dir and swaps each path in', () => {
    const ws = source();
    const t = new Task({
      name: 'go-test',
      workspaces: [ws],
      steps: [{ name: 's', image: 'go' }],
      caches: [goCache(ws, store())],
    });
    const script = restoreScript(t);
    expect(script).toContain('let stage = $".cache-restore-(random uuid)"');
    expect(script).toContain('tar xf - -C $stage');
    // The staging dir goes away whether extraction succeeded or failed.
    expect(script).toContain('rm -rf $stage');
  });

});

describe('compressed PVC restore of an unextractable archive', () => {
  const task = () => {
    const ws = source();
    return new Task({
      name: 'go-test',
      workspaces: [ws],
      steps: [{ name: 's', image: 'go' }],
      caches: [goCache(ws, store())],
    });
  };

  // Save skips a hash whose archive exists, so failing the restore would fail every later
  // run on that hash until someone deleted the archive by hand (ocidex-zhji).
  it('discards the archive and continues as a miss instead of failing', () => {
    const script = restoreScript(task());
    const onFailure = script.slice(script.indexOf('extract failed'));
    expect(onFailure).toContain('rm -f $archive');
    expect(onFailure).toContain('exit 0');
    expect(onFailure).not.toMatch(/exit 1\n/);
  });

  it('makes a partial stage writable before removing it', () => {
    const script = restoreScript(task());
    expect(script.indexOf('^chmod -R u+w $stage')).toBeGreaterThan(-1);
    expect(script.indexOf('^chmod -R u+w $stage')).toBeLessThan(script.indexOf('rm -rf $stage'));
  });

  it('saves archives with owner-writable modes', () => {
    const app = new App();
    const chart = new Chart(app, 'test');
    task().synth(chart, 'ns', CAPABLE);
    const save = (chart.toJson()[0] as AnyObj).spec.steps.find((s: AnyObj) => s.name.startsWith('save-')).script;
    expect(save).toContain('tar cf - --mode=u+w');
  });

  it('keeps the shared helper failing by default for other backends', () => {
    const script = stagedExtract(
      { name: 'x', key: [], paths: ['p'] } as never,
      'restore-x-cache',
      '^tar xf - -C $stage',
    );
    expect(script).toContain('  exit 1\n}');
    expect(script).not.toContain('rm -f $archive');
  });
});

describe('shared-workspace cache detection', () => {
  afterEach(() => vi.restoreAllMocks());

  const pipelineWithTasks = (cacheTaskExtra: Record<string, unknown> = {}) => {
    const ws = source();
    const cacheWs = store();
    const cached = new Task({
      name: 'go-test',
      workspaces: [ws],
      stepTemplate: { workingDir: `$(workspaces.${ws.name}.path)` },
      steps: [{ name: 's', image: 'go' }],
      caches: [goCache(ws, cacheWs, cacheTaskExtra)],
    });
    const other = new Task({
      name: 'go-build',
      workspaces: [ws],
      steps: [{ name: 's', image: 'go' }],
    });
    return { cached, other, ws };
  };

  it('defaults a cache on a workspace other tasks mount to skipRestoreIfPathsExist', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { cached, other } = pipelineWithTasks();
    new Pipeline({ name: 'ci', tasks: [cached, other] });
    expect(restoreScript(cached)).toContain('paths already exist, skipping restore');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("cache 'go' restores into workspace 'workspace'"));
  });

  it('leaves an explicit skipRestoreIfPathsExist: false alone', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { cached, other } = pipelineWithTasks({ skipRestoreIfPathsExist: false });
    new Pipeline({ name: 'ci', tasks: [cached, other] });
    expect(restoreScript(cached)).not.toContain('paths already exist, skipping restore');
    expect(warn).not.toHaveBeenCalled();
  });

  it('does not flag a cache when no other task mounts the workspace', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const ws = source();
    const cached = new Task({
      name: 'go-test',
      workspaces: [ws],
      stepTemplate: { workingDir: `$(workspaces.${ws.name}.path)` },
      steps: [{ name: 's', image: 'go' }],
      caches: [goCache(ws, store())],
    });
    new Pipeline({ name: 'ci', tasks: [cached] });
    expect(restoreScript(cached)).not.toContain('paths already exist, skipping restore');
    expect(warn).not.toHaveBeenCalled();
  });

  it('does not flag a cache whose workingDir is not workspace-relative', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const ws = source();
    const cacheWs = store();
    const cached = new Task({
      name: 'tooldb',
      workspaces: [ws],
      steps: [{ name: 's', image: 'go' }],
      caches: [{ name: 'db', key: [], paths: ['db'], compress: true, workspace: cacheWs, workingDir: '/tmp' }],
    });
    const other = new Task({ name: 'other', workspaces: [ws], steps: [{ name: 's', image: 'go' }] });
    new Pipeline({ name: 'ci', tasks: [cached, other] });
    expect(restoreScript(cached)).not.toContain('paths already exist, skipping restore');
    expect(warn).not.toHaveBeenCalled();
  });
});
