import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { diffDirs, isClean, listFiles, formatDiff, syncDir } from './diff';
import { renderText, renderMermaid, type ProjectGraph } from './graph';
import { resolveEntry, runnerFor, ENTRY_CANDIDATES } from './entry';
import { collectScripts } from './lint';
import { parseFlags } from './index';

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tektonic-cli-test-'));
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

const write = (rel: string, content: string): string => {
  const abs = path.join(tmp, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
  return abs;
};

describe('diffDirs', () => {
  it('reports a clean tree when both sides match', () => {
    write('fresh/a.yaml', 'x');
    write('fresh/tasks/b.yaml', 'y');
    write('committed/a.yaml', 'x');
    write('committed/tasks/b.yaml', 'y');
    const diff = diffDirs(path.join(tmp, 'fresh'), path.join(tmp, 'committed'));
    expect(isClean(diff)).toBe(true);
  });

  it('reports a hand-edited file as stale', () => {
    write('fresh/a.yaml', 'generated');
    write('committed/a.yaml', 'hand edited');
    const diff = diffDirs(path.join(tmp, 'fresh'), path.join(tmp, 'committed'));
    expect(diff.stale).toEqual(['a.yaml']);
    expect(isClean(diff)).toBe(false);
  });

  it('reports a newly emitted file as missing', () => {
    write('fresh/a.yaml', 'x');
    write('fresh/tasks/new.yaml', 'x');
    write('committed/a.yaml', 'x');
    const diff = diffDirs(path.join(tmp, 'fresh'), path.join(tmp, 'committed'));
    expect(diff.missing).toEqual(['tasks/new.yaml']);
  });

  // The reason check re-synthesizes into a temp dir instead of synthesizing in place and
  // reading `git status`: a file the project stopped emitting stays committed and applied.
  it('reports a file the project no longer emits as an orphan', () => {
    write('fresh/a.yaml', 'x');
    write('committed/a.yaml', 'x');
    write('committed/tasks/dropped.yaml', 'x');
    const diff = diffDirs(path.join(tmp, 'fresh'), path.join(tmp, 'committed'));
    expect(diff.orphan).toEqual(['tasks/dropped.yaml']);
  });

  it('treats a missing committed directory as everything missing', () => {
    write('fresh/a.yaml', 'x');
    const diff = diffDirs(path.join(tmp, 'fresh'), path.join(tmp, 'nope'));
    expect(diff.missing).toEqual(['a.yaml']);
    expect(listFiles(path.join(tmp, 'nope'))).toEqual([]);
  });

  it('formats each finding with its path and reason', () => {
    const lines = formatDiff('.tekton', { stale: ['a.yaml'], missing: ['b.yaml'], orphan: ['c.yaml'] });
    expect(lines[0]).toContain('.tekton/a.yaml');
    expect(lines[1]).toContain('.tekton/b.yaml');
    expect(lines[2]).toContain('.tekton/c.yaml');
  });
});

describe('syncDir', () => {
  it('writes new and changed files, deletes orphans and the directories they empty', () => {
    write('fresh/a.yaml', 'new');
    write('fresh/tasks/b.yaml', 'b');
    write('target/a.yaml', 'old');
    write('target/tasks/b.yaml', 'b');
    write('target/gone/deep/c.yaml', 'c');
    const { removed } = syncDir(path.join(tmp, 'fresh'), path.join(tmp, 'target'));
    expect(removed).toEqual(['gone/deep/c.yaml']);
    expect(fs.readFileSync(path.join(tmp, 'target/a.yaml'), 'utf8')).toBe('new');
    expect(fs.existsSync(path.join(tmp, 'target/gone'))).toBe(false);
    expect(isClean(diffDirs(path.join(tmp, 'fresh'), path.join(tmp, 'target')))).toBe(true);
  });

  it('leaves identical files untouched', () => {
    write('fresh/a.yaml', 'x');
    const kept = write('target/a.yaml', 'x');
    const past = new Date('2020-01-01');
    fs.utimesSync(kept, past, past);
    syncDir(path.join(tmp, 'fresh'), path.join(tmp, 'target'));
    expect(fs.statSync(kept).mtime.getTime()).toBe(past.getTime());
  });

  it('creates the target when it does not exist yet', () => {
    write('fresh/tasks/b.yaml', 'b');
    syncDir(path.join(tmp, 'fresh'), path.join(tmp, 'target'));
    expect(fs.readFileSync(path.join(tmp, 'target/tasks/b.yaml'), 'utf8')).toBe('b');
  });
});

describe('entry resolution', () => {
  it('prefers an explicit path', () => {
    const entry = write('custom/pipeline.ts', '');
    expect(resolveEntry('custom/pipeline.ts', tmp)).toBe(entry);
  });

  it('throws when the explicit path does not exist', () => {
    expect(() => resolveEntry('nope.ts', tmp)).toThrow(/does not exist/);
  });

  it('falls back to package.json "tektonic.entry"', () => {
    const entry = write('infra/tekton.ts', '');
    write('package.json', JSON.stringify({ tektonic: { entry: 'infra/tekton.ts' } }));
    expect(resolveEntry(undefined, tmp)).toBe(entry);
  });

  it('falls back to a conventional path', () => {
    const entry = write('.tektonic/pipeline.ts', '');
    expect(ENTRY_CANDIDATES).toContain('.tektonic/pipeline.ts');
    expect(resolveEntry(undefined, tmp)).toBe(entry);
  });

  it('lists what it looked for when nothing matches', () => {
    expect(() => resolveEntry(undefined, tmp)).toThrow(/no project entrypoint found/);
  });

  it('runs JavaScript entrypoints on bare node', () => {
    const { command, args } = runnerFor(path.join(tmp, 'x.js'), tmp);
    expect(command).toBe(process.execPath);
    expect(args).toEqual([path.join(tmp, 'x.js')]);
  });

  // TypeScript gets no loader and no --require: node strips the types itself. A loader
  // installed alongside the project must not change the command that runs.
  it('runs TypeScript entrypoints on bare node too', () => {
    const { command, args } = runnerFor(path.join(tmp, 'x.ts'), tmp);
    expect(command).toBe(process.execPath);
    expect(args).toEqual([
      '--disable-warning=MODULE_TYPELESS_PACKAGE_JSON',
      path.join(tmp, 'x.ts'),
    ]);
  });

  it('honours an explicit runner from package.json', () => {
    write('package.json', JSON.stringify({ tektonic: { runner: 'npx tsx' } }));
    const { command, args } = runnerFor(path.join(tmp, 'x.ts'), tmp);
    expect(command).toBe('npx');
    expect(args).toEqual(['tsx', path.join(tmp, 'x.ts')]);
  });
});

describe('graph rendering', () => {
  const graph: ProjectGraph[] = [
    {
      outdir: '.tekton',
      pipelines: [
        {
          name: 'pr',
          events: ['pull_request'],
          tasks: [
            { name: 'clone', runAfter: [], gated: false },
            { name: 'test', runAfter: ['clone'], gated: false },
            { name: 'deploy', runAfter: ['test'], gated: true },
          ],
          finally: [{ name: 'reconcile-status-pr', runAfter: [], gated: false }],
        },
      ],
    },
  ];

  it('renders dependency levels and marks gated tasks', () => {
    const text = renderText(graph);
    expect(text).toContain('pr [pull_request]');
    expect(text).toContain('  first:\n    - clone');
    expect(text).toContain('after clone:');
    expect(text).toContain('? deploy');
    expect(text).toContain('  finally:\n    - reconcile-status-pr');
  });

  it('renders a mermaid flowchart with one edge per runAfter', () => {
    const mermaid = renderMermaid(graph);
    expect(mermaid).toContain('flowchart TD');
    expect(mermaid).toContain('pr_clone --> pr_test');
    expect(mermaid).toContain('pr_test --> pr_deploy');
    // Gated tasks get the hexagon shape so a conditional edge is visible at a glance.
    expect(mermaid).toContain('pr_deploy{{"deploy"}}');
  });
});

describe('lint file collection', () => {
  it('collects script files and skips node_modules, dist and dotfiles', () => {
    write('a.sh', '');
    write('sub/b.nu', '');
    write('c.py', '');
    write('d.ts', '');
    write('node_modules/e.sh', '');
    write('dist/f.sh', '');
    write('.hidden/g.sh', '');
    expect(collectScripts(tmp).map(f => path.relative(tmp, f)).sort()).toEqual([
      'a.sh',
      'c.py',
      path.join('sub', 'b.nu'),
    ]);
  });
});

describe('flag parsing', () => {
  it('parses --flag value, --flag=value, bare flags and short aliases', () => {
    expect(parseFlags(['synth', 'x.ts', '--outdir', 'out'])).toEqual({
      flags: { outdir: 'out' },
      positional: ['synth', 'x.ts'],
    });
    expect(parseFlags(['graph', '--format=mermaid']).flags).toEqual({ format: 'mermaid' });
    expect(parseFlags(['-v']).flags).toEqual({ version: 'true' });
    expect(parseFlags(['-h']).flags).toEqual({ help: 'true' });
  });
});

// End-to-end: the CLI must actually run a project entrypoint and diff its output. Uses the
// built dist, which is what the `tektonic` bin points at.
describe('tektonic check (end to end)', () => {
  const cli = path.resolve(__dirname, '../../dist/cli/index.js');
  const repoRoot = path.resolve(__dirname, '../..');

  beforeEach(() => {
    if (!fs.existsSync(cli)) {
      throw new Error(`dist is not built — run 'npm run build' before 'npm test' (missing ${cli})`);
    }
  });

  const project = (outdir: string) => `
const { Task, GitPipeline, TektonicProject, TRIGGER_EVENTS } = require(${JSON.stringify(repoRoot + '/dist/index.js')});
const test = new Task({ name: 'test', steps: [{ name: 's', image: 'alpine' }] });
new TektonicProject({
  name: 'demo',
  namespace: 'demo-ci',
  outdir: ${JSON.stringify(outdir)},
  pipelines: [new GitPipeline({ name: 'push', trigger: { rules: [{ on: TRIGGER_EVENTS.PUSH }] }, tasks: [test] })],
});
`;

  const runCli = (args: string[]): { status: number; output: string } => {
    try {
      const output = execFileSync(process.execPath, [cli, ...args], { cwd: tmp, encoding: 'utf8' });
      return { status: 0, output };
    } catch (err) {
      const e = err as { status: number; stdout: string; stderr: string };
      return { status: e.status, output: `${e.stdout}${e.stderr}` };
    }
  };

  it('exits zero on freshly synthesized output and non-zero once it is edited', () => {
    write('tektonic.js', project('.tekton'));
    expect(runCli(['synth']).status).toBe(0);
    expect(fs.existsSync(path.join(tmp, '.tekton', 'demo-push.k8s.yaml'))).toBe(true);

    const clean = runCli(['check']);
    expect(clean.status).toBe(0);
    expect(clean.output).toContain('.tekton is up to date');

    fs.appendFileSync(path.join(tmp, '.tekton', 'demo-push.k8s.yaml'), '\n# hand edited\n');
    const edited = runCli(['check']);
    expect(edited.status).toBe(1);
    expect(edited.output).toContain('stale');
  });

  it('flags a manifest the project no longer emits', () => {
    write('tektonic.js', project('.tekton'));
    expect(runCli(['synth']).status).toBe(0);
    write('.tekton/tasks/removed-task.k8s.yaml', 'apiVersion: tekton.dev/v1\n');
    const result = runCli(['check']);
    expect(result.status).toBe(1);
    expect(result.output).toContain('orphan');
    expect(result.output).toContain('removed-task.k8s.yaml');
  });

  it('removes a manifest the project no longer emits, so check passes again', () => {
    write('tektonic.js', project('.tekton'));
    expect(runCli(['synth']).status).toBe(0);
    write('.tekton/tasks/removed-task.k8s.yaml', 'apiVersion: tekton.dev/v1\n');
    const result = runCli(['synth']);
    expect(result.status).toBe(0);
    expect(result.output).toContain('removed .tekton/tasks/removed-task.k8s.yaml');
    expect(fs.existsSync(path.join(tmp, '.tekton', 'tasks', 'removed-task.k8s.yaml'))).toBe(false);
    expect(fs.existsSync(path.join(tmp, '.tekton', 'demo-push.k8s.yaml'))).toBe(true);
    expect(runCli(['check']).status).toBe(0);
  });

  it('removes nothing when synthesis fails', () => {
    write('tektonic.js', project('.tekton'));
    expect(runCli(['synth']).status).toBe(0);
    write('tektonic.js', 'throw new Error("broken entrypoint")');
    expect(runCli(['synth']).status).not.toBe(0);
    expect(fs.existsSync(path.join(tmp, '.tekton', 'demo-push.k8s.yaml'))).toBe(true);
  });

  // The redirect must not leak into the emitted YAML: PAC task annotations carry the
  // repo-relative outdir, so a check that changed them would compare noise.
  it('emits identical manifests whether or not the outdir is redirected', () => {
    write('tektonic.js', project('.tekton'));
    expect(runCli(['synth']).status).toBe(0);
    expect(runCli(['synth', '--outdir', 'redirected']).status).toBe(0);
    const direct = fs.readFileSync(path.join(tmp, '.tekton', 'demo-push.k8s.yaml'), 'utf8');
    const redirected = fs.readFileSync(
      path.join(tmp, 'redirected', '.tekton', 'demo-push.k8s.yaml'),
      'utf8',
    );
    expect(redirected).toBe(direct);
  });

  it('renders the DAG without touching the committed output', () => {
    write('tektonic.js', project('.tekton'));
    expect(runCli(['synth']).status).toBe(0);
    const before = fs.readFileSync(path.join(tmp, '.tekton', 'demo-push.k8s.yaml'), 'utf8');
    const graph = runCli(['graph']);
    expect(graph.status).toBe(0);
    expect(graph.output).toContain('push [push]');
    expect(graph.output).toContain('git-clone');
    expect(fs.readFileSync(path.join(tmp, '.tekton', 'demo-push.k8s.yaml'), 'utf8')).toBe(before);
  });

  it('reports a missing entrypoint instead of throwing', () => {
    const result = runCli(['check']);
    expect(result.status).toBe(1);
    expect(result.output).toContain('no project entrypoint found');
  });
});

// `--target` narrows a synthesis to one of the targets the project already declares — the
// route to a catalog tree, which nothing else should have to emit alongside.
describe('tektonic synth --target (end to end)', () => {
  const cli = path.resolve(__dirname, '../../dist/cli/index.js');
  const repoRoot = path.resolve(__dirname, '../..');

  const project = `
const { Task, GitPipeline, TektonicProject, TRIGGER_EVENTS, PacTarget, HubTarget } = require(${JSON.stringify(repoRoot + '/dist/index.js')});
const test = new Task({ name: 'test', steps: [{ name: 's', image: 'docker.io/alpine:3.20' }] });
new TektonicProject({
  name: 'demo',
  namespace: 'demo-ci',
  outdir: '.tekton',
  pipelines: [new GitPipeline({
    name: 'push',
    trigger: { rules: [{ on: TRIGGER_EVENTS.PUSH }] },
    cloneCatalog: { version: '0.1', description: 'Clones a git repository.', categories: ['Git'] },
    tasks: [test],
  })],
  targets: [new PacTarget(), new HubTarget()],
});
`;

  const runCli = (args: string[]): { status: number; output: string } => {
    try {
      return { status: 0, output: execFileSync(process.execPath, [cli, ...args], { cwd: tmp, encoding: 'utf8' }) };
    } catch (err) {
      const e = err as { status: number; stdout: string; stderr: string };
      return { status: e.status, output: `${e.stdout}${e.stderr}` };
    }
  };
  const emitted = (rel: string): boolean => fs.existsSync(path.join(tmp, rel));

  beforeEach(() => {
    write('tektonic.js', project);
  });

  it('emits every declared target when none is named', () => {
    expect(runCli(['synth']).status).toBe(0);
    expect(emitted('.tekton/demo-push.k8s.yaml')).toBe(true);
    expect(emitted('.tekton/task/git-clone/0.1/git-clone.yaml')).toBe(true);
  });

  // --target emits a subset of what the outdir holds, so everything else in it must survive.
  it('keeps the other targets\' files when narrowed to one', () => {
    expect(runCli(['synth']).status).toBe(0);
    expect(runCli(['synth', '--target', 'hub']).status).toBe(0);
    expect(emitted('.tekton/demo-push.k8s.yaml')).toBe(true);
  });

  it('emits only the named target, into the outdir it was given', () => {
    expect(runCli(['synth', '--target', 'hub', '--outdir', 'catalog']).status).toBe(0);
    expect(emitted('catalog/.tekton/task/git-clone/0.1/git-clone.yaml')).toBe(true);
    expect(emitted('catalog/.tekton/demo-push.k8s.yaml')).toBe(false);
  });

  it('fails naming the project’s targets when asked for one it does not declare', () => {
    const result = runCli(['synth', '--target', 'hubb']);
    expect(result.status).not.toBe(0);
    expect(result.output).toContain("--target 'hubb'");
    expect(result.output).toContain('[pac, hub]');
  });

  it('rejects a bare --target rather than treating it as a target named true', () => {
    const result = runCli(['synth', '--target']);
    expect(result.status).toBe(2);
    expect(result.output).toContain('--target needs a target name');
  });
});
