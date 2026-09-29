# Testing your pipelines

A pipeline definition is code, so it can be unit-tested like code. `@tektonic-ci/core/testing`
synthesizes a pipeline or a task **in memory** — no files written, no cluster — and wraps the
result for the assertions tests actually make: is this task present, what gates it, what does it
run after, what params are bound.

```bash
npm install --save-dev vitest   # or your runner of choice
```

```typescript
import { describe, it, expect } from 'vitest';
import { synthPipeline } from '@tektonic-ci/core/testing';
import { prPipeline } from './pipeline';   // your own definition
```

## Asserting gating

The case worth a test: a frontend-only PR must not run the Go jobs.

```typescript
it('gates the Go tasks on Go changes', () => {
  const pr = synthPipeline(prPipeline);

  expect(pr.has('go-test')).toBe(true);
  expect(pr.isGated('go-test')).toBe(true);
  expect(pr.when('go-test')).toEqual([
    { input: '$(tasks.detect-go-changes.results.changed)', operator: 'in', values: ['true'] },
  ]);
  // The detection task is wired in as an ordering edge, not just referenced.
  expect(pr.runAfter('go-test')).toContain('detect-go-changes');

  // …and the frontend task runs unconditionally.
  expect(pr.isGated('frontend-test')).toBe(false);
});
```

`synthPipeline` runs the same code path `TektonicProject` uses to inline the spec into a PAC
PipelineRun — validation, topological sort, `runAfter` wiring, `gated()` overrides — so the test
sees exactly what would be emitted.

## `PipelineView`

| Member | Returns |
|--------|---------|
| `spec` | the raw built spec (`params`, `workspaces`, `tasks`, `finally`) |
| `taskNames` / `finallyNames` | emitted task names, in topological order |
| `paramNames` / `workspaceNames` | pipeline-level params and workspaces |
| `has(name)` | whether the pipeline emits that task |
| `task(name)` | the entry: `runAfter`, `when`, `params`, `workspaces`, `retries`, `timeout`, `matrix`, `raw` |
| `runAfter(name)` / `when(name)` / `isGated(name)` / `params(name)` | shorthands for the above |

`task()` throws and lists every emitted name when the task is absent — a missing task is usually
the point of the test.

## `TaskView`

`synthTask(task)` returns the Task manifest that would be written to `<outdir>/tasks/`, and
`synthTasks(pipeline)` does it for every task a pipeline emits, keyed by name.

```typescript
const view = synthTask(buildTask, { namespace: 'ci' });

// Framework-injected steps are present, in position.
expect(view.stepNames).toEqual(['restore-npm-cache', 'build', 'save-npm-cache', 'report-status']);
// The exit-code contract is applied to the user body, not hand-written by the author.
expect(view.script('build')).toContain('/tekton/home/.exit-code');
```

| Member | Returns |
|--------|---------|
| `manifest` | the full Task manifest |
| `name` | emitted resource name, including any project prefix |
| `stepNames` | step names in order, framework-injected steps included |
| `paramNames` | declared params, including any a status reporter merged in |
| `step(name)` / `script(name)` | one step, or its rendered script |

## Project-level output

These helpers stop at the pipeline and task level. To check that the **committed** `.tekton/`
output matches the definition — including PAC annotations, PipelineRun bindings and files the
project no longer emits — use the CLI's drift check in CI:

```bash
tektonic check
```

See [cli.md](cli.md).

## Options

Both helpers take the project-level defaults that affect synthesis, for when a test needs to
match what `TektonicProject` would produce:

```typescript
synthPipeline(pipeline, { namePrefix: 'demo', extraParams: PAC_INJECTED_PARAMS.map(p => p.toSpec()) });
synthTask(task, { namespace: 'ci', namePrefix: 'demo', defaultLanguage: 'nushell' });
```

## Testing a provider: the conformance kit

A status reporter, cache backend or artifact store written in another package is plugged into
core's synthesis, so core can break it without changing a single type. A default image changed,
a step injected where yours used to be, or a pending task wired differently: the provider still
compiles, and the break shows up only in the pipelines built with it. Core's `check-api` step
catches the type-level breaks. The conformance kit is for the behavioural ones.

Each suite takes a factory for your implementation and drives it through core's own synthesis,
the way a project using it would, then checks what core relies on. A check that fails throws an
`Error` naming the contract it broke. If every check passes, the suite returns the list of checks
it ran. It works with any test runner:

```typescript
import { it } from 'vitest';
import {
  assertStatusReporterConformance,
  assertCacheBackendConformance,
  assertArtifactStoreConformance,
} from '@tektonic-ci/core/testing';
import type { InjectedStepImage } from '@tektonic-ci/core';

// The image your users are expected to configure. Steps that ask for a capability through
// injectedImageRef(...) resolve against it, and a missing one fails here as it would for them.
const injectedStepImage: InjectedStepImage = { image: 'ghcr.io/acme/ci:1', provides: ['sh', 'git', 'nushell'] };

it('conforms to the StatusReporter contract', () => {
  assertStatusReporterConformance(() => new SlackStatusReporter({ channel: '#ci' }), { injectedStepImage });
});
it('conforms to the CacheBackend contract', () => {
  assertCacheBackendConformance(() => s3({ bucket: 'ci-cache' }), { injectedStepImage });
});
it('conforms to the ArtifactStore contract', () => {
  assertArtifactStoreConformance(() => s3Artifacts({ bucket: 'ci-artifacts' }), { injectedStepImage });
});
```

| Suite | Checks |
|-------|--------|
| `assertStatusReporterConformance` | `requiredParams` are uniquely named and reach every reporting task. The pending task takes the name core gives it, carries every context and runs ahead of every reporting task. `finalStep` is a valid, deterministic step that runs last and doesn't take a common step name. A reconciler, if present, lands in `finally` and reads `$(tasks.<name>.status)` for every reporting task. `pendingGroupKey`, if present, is stable. The pipeline synthesizes the same way twice. |
| `assertCacheBackendConformance` | `type` and `needsPvcWorkspace` are set. Restore and save are valid steps, named apart across two caches on one task. `spec.image` overrides the backend's default. Restore runs first and save last, and `saveStrategy: 'finally'` synthesizes a separate save task. |
| `assertArtifactStoreConformance` | `type` and `needsWorkspace` are set. `path` is absolute (or rooted at `$(workspaces.<name>.path)`), stable, and unique per producer and name. Publish and fetch are valid steps, named per artifact. `uri`, if present, has a scheme. A producer and consumer synthesize with publish after the user steps and fetch before them. |

The suites cover what every implementation must do. Keep your own tests for what yours does:
the script it runs, and the API it calls.

### Running it against the next core

A test run against the core release you already depend on only tells you the provider works
with that release. To find out whether the **next** one breaks it, add a CI job that installs
core's prerelease channel over your locked version and runs the same tests:

```bash
npm ci
npm install --no-save @tektonic-ci/core@next
npm test
```

Core publishes prereleases (`3.0.0-next.0` and so on) on the npm `next` dist-tag before the
release reaches `latest`, so this job fails while the change can still be fixed. Every release
also moves `next` to itself, so `next` is never behind `latest`, and between prereleases the job
tests the current release. The kit knows nothing about any provider: yours runs it in your CI, and
core never needs a list of who is out there.

Keep the job advisory, so a red `next` build doesn't block your own releases. `npm install
--no-save` leaves `package-lock.json` alone, so your locked build and your releases are
unaffected.
