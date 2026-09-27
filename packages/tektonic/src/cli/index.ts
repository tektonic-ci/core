#!/usr/bin/env node
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { CLI_ENV } from '../lib/core/tektonic-project';
import { resolveEntry, runnerFor } from './entry';
import { diffDirs, formatDiff, isClean, syncDir } from './diff';
import { renderMermaid, renderText, type ProjectGraph } from './graph';
import { lintScripts } from './lint';

const USAGE = `tektonic — synthesize and verify Tekton pipelines

Usage:
  tektonic synth [entry] [--outdir <dir>] [--target <name>]
                                            Run the project entrypoint, writing its manifests and
                                            removing the ones it no longer emits
  tektonic check [entry]                    Synthesize to a temp dir and diff against the committed output
  tektonic graph [entry] [--format text|mermaid]
                                            Render the task DAG of each triggered pipeline
  tektonic lint [paths...]                  Lint script files (shellcheck / nu-check / py_compile)

The entrypoint is the file that constructs a TektonicProject. It is found from the argument,
then "tektonic": { "entry": "..." } in package.json, then conventional paths (tektonic.ts,
.tektonic/pipeline.ts, …). "tektonic": { "runner": "..." } overrides how it is executed.

--target narrows synthesis to one of the targets the project already declares (pac, tekton,
hub, ...), so 'tektonic synth --target hub --outdir catalog' writes a catalog tree and nothing
else. Repeat it comma-separated for several.

Options:
  -h, --help      Show this help
  -v, --version   Show the tektonic version`;

/** Single-dash aliases, expanded to their long form before parsing. */
const SHORT_FLAGS: Record<string, string> = { '-h': 'help', '-v': 'version' };

/**
 * Parses `--flag value` / `--flag=value` pairs (and the short aliases) out of the argument
 * list, returning the rest as positional arguments.
 */
export function parseFlags(argv: string[]): { flags: Record<string, string>; positional: string[] } {
  const flags: Record<string, string> = {};
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (SHORT_FLAGS[arg]) {
      flags[SHORT_FLAGS[arg]] = 'true';
      continue;
    }
    if (!arg.startsWith('--')) {
      positional.push(arg);
      continue;
    }
    const [name, inline] = arg.slice(2).split('=', 2);
    if (inline !== undefined) flags[name] = inline;
    else if (argv[i + 1] && !argv[i + 1].startsWith('--')) flags[name] = argv[++i];
    else flags[name] = 'true';
  }
  return { flags, positional };
}

/**
 * Runs a project entrypoint in a child process with the given CLI environment.
 *
 * A child process rather than an in-process `require` because synthesis is a constructor side
 * effect: the entrypoint must run exactly the way `node <entry>` would, including its own
 * TypeScript setup, and must not be able to leave state behind in the CLI.
 */
function runEntry(entry: string, cwd: string, env: NodeJS.ProcessEnv): number {
  const { command, args } = runnerFor(entry, cwd);
  const res = spawnSync(command, args, { cwd, stdio: 'inherit', env: { ...process.env, ...env } });
  if (res.error) {
    console.error(`tektonic: could not run '${entry}': ${res.error.message}`);
    return 1;
  }
  return res.status ?? 1;
}

/** Creates a temp directory for a redirected synthesis, plus the manifest file inside it. */
function tempSynthDir(prefix: string): { root: string; manifest: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const manifest = path.join(root, 'manifest.jsonl');
  fs.writeFileSync(manifest, '');
  return { root, manifest };
}

/** Reads a JSON-lines manifest written by one or more TektonicProject constructions. */
function readManifest<T>(file: string): T[] {
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter(line => line.trim().length > 0)
    .map(line => JSON.parse(line) as T);
}

function cmdSynth(positional: string[], flags: Record<string, string>, cwd: string): number {
  const entry = resolveEntry(positional[0], cwd);
  if (flags.target === 'true') {
    console.error(`tektonic synth: --target needs a target name (e.g. --target hub)`);
    return 2;
  }
  // A narrowed or redirected synthesis writes in place and removes nothing: `--target` emits a
  // subset of what the outdir holds, and `--outdir` is a scratch tree the project doesn't own.
  if (flags.outdir || flags.target) {
    const env = {
      ...(flags.outdir ? { [CLI_ENV.outdir]: path.resolve(cwd, flags.outdir) } : {}),
      ...(flags.target ? { [CLI_ENV.targets]: flags.target } : {}),
    };
    return runEntry(entry, cwd, env);
  }

  // A full synthesis goes through a temp dir and is then synced into each declared outdir,
  // deleting the files the project no longer emits. Writing in place would leave those behind,
  // and `check` — which treats the outdir as the project's — would fail until someone found
  // and deleted them by hand.
  const { root, manifest } = tempSynthDir('tektonic-synth-');
  try {
    const status = runEntry(entry, cwd, { [CLI_ENV.outdir]: root, [CLI_ENV.synthManifest]: manifest });
    if (status !== 0) return status;
    const redirects = readManifest<{ declared: string; actual: string }>(manifest);
    if (redirects.length === 0) {
      console.error(
        `tektonic synth: '${path.relative(cwd, entry)}' synthesized no project — ` +
          `the entrypoint must construct a TektonicProject when run.`,
      );
      return 1;
    }
    const synced = new Set<string>();
    for (const { declared, actual } of redirects) {
      if (synced.has(declared)) continue;
      synced.add(declared);
      const target = path.resolve(cwd, declared);
      const { removed } = syncDir(actual, target);
      for (const f of removed) console.log(`tektonic synth: removed ${declared}/${f} — no longer emitted`);
    }
    return 0;
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function cmdCheck(positional: string[], cwd: string): number {
  const entry = resolveEntry(positional[0], cwd);
  const { root, manifest } = tempSynthDir('tektonic-check-');
  try {
    const status = runEntry(entry, cwd, { [CLI_ENV.outdir]: root, [CLI_ENV.synthManifest]: manifest });
    if (status !== 0) return status;

    const redirects = readManifest<{ declared: string; actual: string }>(manifest);
    if (redirects.length === 0) {
      console.error(
        `tektonic check: '${path.relative(cwd, entry)}' synthesized no project — ` +
          `the entrypoint must construct a TektonicProject when run.`,
      );
      return 1;
    }
    let drifted = false;
    for (const { declared, actual } of redirects) {
      const committed = path.resolve(cwd, declared);
      const diff = diffDirs(actual, committed);
      if (isClean(diff)) {
        console.log(`tektonic check: ${declared} is up to date`);
        continue;
      }
      drifted = true;
      console.error(`tektonic check: ${declared} is out of date`);
      for (const line of formatDiff(declared, diff)) console.error(line);
    }
    if (drifted) console.error(`\nRun 'tektonic synth' and commit the result.`);
    return drifted ? 1 : 0;
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function cmdGraph(positional: string[], flags: Record<string, string>, cwd: string): number {
  const entry = resolveEntry(positional[0], cwd);
  const format = flags.format ?? 'text';
  if (format !== 'text' && format !== 'mermaid') {
    console.error(`tektonic graph: unknown --format '${format}' (expected text or mermaid)`);
    return 2;
  }
  // Graphing runs a real synthesis, so it is redirected to a temp dir the same way `check` is —
  // rendering the DAG must never overwrite the committed manifests.
  const { root, manifest } = tempSynthDir('tektonic-graph-');
  const graphFile = path.join(root, 'graph.jsonl');
  fs.writeFileSync(graphFile, '');
  try {
    const status = runEntry(entry, cwd, {
      [CLI_ENV.outdir]: root,
      [CLI_ENV.synthManifest]: manifest,
      [CLI_ENV.graphManifest]: graphFile,
    });
    if (status !== 0) return status;
    const graphs = readManifest<ProjectGraph>(graphFile);
    if (graphs.length === 0) {
      console.error('tektonic graph: no triggered pipelines were synthesized');
      return 1;
    }
    console.log(format === 'mermaid' ? renderMermaid(graphs) : renderText(graphs));
    return 0;
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function cmdLint(positional: string[], cwd: string): number {
  const targets = positional.length > 0 ? positional : [cwd];
  const result = lintScripts(targets, msg => console.log(msg));
  if (result.skipped.length > 0) {
    console.log(`tektonic lint: linters not installed, skipped: ${result.skipped.join(', ')}`);
  }
  if (result.failures.length > 0) {
    console.error(`tektonic lint: ${result.failures.length} of ${result.checked} file(s) failed`);
    return 1;
  }
  console.log(`tektonic lint: ${result.checked} file(s) OK`);
  return 0;
}

/** Runs the CLI. Exported for tests; `main()` below wires it to the real process. */
export function run(argv: string[], cwd: string = process.cwd()): number {
  const { flags, positional } = parseFlags(argv);
  const command = positional[0];
  const rest = positional.slice(1);

  if (flags.version || command === 'version') {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    console.log((require('../../package.json') as { version: string }).version);
    return 0;
  }
  if (flags.help || command === 'help') {
    console.log(USAGE);
    return 0;
  }
  // No command at all: usage, and a non-zero status so a bare invocation in a script fails.
  if (command === undefined) {
    console.log(USAGE);
    return 2;
  }

  try {
    switch (command) {
      case 'synth':
        return cmdSynth(rest, flags, cwd);
      case 'check':
        return cmdCheck(rest, cwd);
      case 'graph':
        return cmdGraph(rest, flags, cwd);
      case 'lint':
        return cmdLint(rest, cwd);
      default:
        console.error(`tektonic: unknown command '${command}'\n`);
        console.error(USAGE);
        return 2;
    }
  } catch (err) {
    console.error(`tektonic: ${(err as Error).message}`);
    return 1;
  }
}

/* istanbul ignore next — process wiring, exercised by running the binary. */
if (require.main === module) {
  process.exit(run(process.argv.slice(2)));
}
