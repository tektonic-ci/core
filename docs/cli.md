# The `tektonic` CLI

Installing `@tektonic-ci/core` puts a `tektonic` binary on your `PATH` (via `npx tektonic`, or
directly from `node_modules/.bin`). It drives *your* project definition — the file that
constructs a `TektonicProject` — so synthesis and drift-checking do not have to be reinvented in
every consumer's Makefile.

```
tektonic synth [entry] [--outdir <dir>] [--target <name>]
                                          Run the project entrypoint, writing its manifests and
                                          removing the ones it no longer emits
tektonic check [entry]                    Synthesize to a temp dir and diff against the committed output
tektonic graph [entry] [--format text|mermaid]
                                          Render the task DAG of each triggered pipeline
tektonic lint [paths...]                  Lint script files (shellcheck / nu-check / py_compile)
```

## The entrypoint

Every command runs your project entrypoint in a child process, exactly as `node <entry>` would.
It is resolved in this order:

1. the path given on the command line — `tektonic check .tektonic/pipeline.ts`
2. `"tektonic": { "entry": "..." }` in the nearest `package.json`
3. conventional paths: `tektonic.ts`, `tektonic.config.ts`, `.tektonic/pipeline.ts`,
   `.tektonic/main.ts`, `.tektonic/index.ts`, and their `.js` equivalents

Entrypoints run on plain `node`, which strips the types from a `.ts` file itself — no loader
is installed, probed for or required. That needs Node 22.18 or newer, and an entrypoint written
in erasable syntax: `enum`, parameter properties and `namespace` cannot be stripped. For either
case, name a runner with `"tektonic": { "runner": "npx tsx" }` and it is used verbatim.

## `synth` — writing the output

`synth` runs the entrypoint and makes each project's `outdir` hold exactly what the project
emits. It synthesizes into a temporary directory first, then writes only the files that are new
or changed, and deletes the ones the project no longer emits, printing each deletion:

```
tektonic synth: removed .tekton/tasks/old-lint.k8s.yaml — no longer emitted
```

So a task you drop from a pipeline disappears from `.tekton/` on the next `synth`, and `check`
passes without anyone deleting files by hand. The outdir belongs to tektonic: anything you
keep there that the project doesn't emit is removed, as `check` would report it as an orphan
anyway. If synthesis fails, nothing is written and nothing is removed.

Narrowed or redirected runs are the exception. `--target` emits a subset of what the outdir
holds, and `--outdir` writes to a directory the project doesn't declare, so both write in place
and remove nothing.

## `check` — drift detection

`check` synthesizes into a temporary directory and compares it, file by file, with the committed
output directory:

| Finding | Meaning |
|---------|---------|
| `stale` | the committed file's content differs from what the project emits |
| `missing` | the project emits a file that was never committed |
| `orphan` | a committed file the project no longer emits |

It exits non-zero if there is any of the three. Orphans are the reason it re-synthesizes
elsewhere rather than synthesizing in place and reading `git status`: a manifest the project
stopped emitting stays committed, and the cluster keeps applying it.

```bash
tektonic check || { echo "run 'tektonic synth' and commit"; exit 1; }
```

Redirection is invisible to the emitted YAML — `repoRelativePath` still follows the *declared*
`outdir`, so PAC task annotations are byte-identical whether synthesis went to `.tekton/` or to a
temp directory. Consumers no longer need an outdir environment variable threaded through their
project definition to make a drift check possible.

### In a Tekton task

`check` is the whole body of a CI drift-check step:

```typescript
new Task({
  name: 'tekton-check',
  steps: [{
    name: 'check',
    image: nodeImage,
    script: sh`
      set -e
      npm ci
      npx tektonic check
    `,
  }],
});
```

Note the plain `set -e` + non-zero exit: hand-rolled drift checks that call `exit 1` from inside
a nushell body have been swallowed by the exit-code contract and reported green on drift. See
[scripting.md](scripting.md).

## `synth --target` — emit one target

A project can declare several synthesis targets, and by default `synth` runs all of them.
`--target` narrows the run to the ones named (comma-separated for several):

```bash
tektonic synth --target hub --outdir catalog
```

It **narrows, it never adds**: a target emits files the project committed to, so `--target` can
only pick from what the entrypoint already declares. Naming one it does not declare fails,
listing the project's targets — an unnoticed typo would otherwise cost a silently empty outdir.

The main use is a target whose output belongs somewhere other than the pipeline manifests, such
as a Tekton catalog tree — see [catalog.md](catalog.md). `check` has no `--target`: it compares a
whole outdir, so a filtered synthesis would report every other target's files as orphans.

## `graph` — review the DAG

```
$ tektonic graph
npm-push [push]
  first:
    - git-clone
  after git-clone:
    - set-status-pending-npm-push
  after set-status-pending-npm-push:
    - anchore-scan
    - test-npm
  finally:
    - reconcile-status-npm-push
```

Tasks are grouped by dependency level; `?` marks a task carrying a `when` guard. `--format
mermaid` emits a flowchart for pasting into a PR or a docs page (gated tasks render as
hexagons). Like `check`, `graph` synthesizes to a temp directory and never touches committed
output.

## `lint`

Walks the given paths (default: the working directory) for `.sh`, `.bash`, `.nu` and `.py` files
and runs each language's linter — `shellcheck`, `nu-check`, `py_compile`. `node_modules`,
`dist` and dotted directories are skipped. A linter that is not installed is reported and
skipped rather than failing the run, so this is safe in any environment.

## Exit codes

| Code | Meaning |
|------|---------|
| `0` | success |
| `1` | drift found, entrypoint failed, or lint failures |
| `2` | usage error (no command, unknown command, bad `--format`, bare `--target`) |
