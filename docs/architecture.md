# Architecture & internals

This is the contributor's guide to how Tektonic is built — read it before changing the core or
adding an extension. For *using* the library, start with the [getting-started](getting-started.md)
and [agent guide](agent-guide.md).

## Design goals

Tektonic exists to make CI/CD pipelines **strongly typed but declarative in spirit**, without
the ceremony and stringly-typed fragility of hand-written YAML. Three principles follow:

1. **The library is a base, not a framework.** Core types (`Param`, `Workspace`, `Result`,
   `Task`, `Pipeline`) are pure orchestration primitives. Tektonic never prescribes how you
   build, test, or deploy your application — opinions like git-cloning live in opt-in subclasses
   (`GitPipeline`), and the images its injected steps run in come from the project
   (`injectedStepImage`), never from a registry the library picked.
2. **Provider concerns are pluggable, and that is verified rather than asserted.** Caching,
   status reporting, scripting languages and *synthesis itself* are strategy interfaces, and
   the Google Cloud Storage backend and the GitHub reporter ship as separate packages, from
   separate repos, that consume only the published surface — so "a third party could implement this" is a thing CI
   checks, not a claim. PAC is one `SynthTarget` among possible others, not the only way out.
3. **The framework owns cross-cutting plumbing.** Exit-code capture, cache restore/save steps,
   git-clone, and status reporting are generated at synth time so consumers write intent, not
   boilerplate.

## Layout

This repository holds core alone, in `packages/tektonic/`. The provider packages live in repos
of their own, and the split is not cosmetic: they build and test against `@tektonic-ci/core`
from npm, so they can import nothing but its published surface. That is the evidence that the
`CacheBackend`, `ArtifactStore` and `StatusReporter` seams support an implementation written
outside this repo, and it makes them the reference implementations to copy:

| Package | Repo | Implements |
|---|---|---|
| `@tektonic-ci/cache-gcs` | [tektonic-ci/cache-gcs](https://github.com/tektonic-ci/cache-gcs) | `CacheBackend` (`GcsBackend`), `ArtifactStore` (`GcsArtifactStore`) |
| `@tektonic-ci/reporter-github` | [tektonic-ci/reporter-github](https://github.com/tektonic-ci/reporter-github) | `StatusReporter` (`GitHubStatusReporter`) |

The GCS package holds two unrelated strategies that happen to share a bucket and an auth
story, so its name names a subset of its contents.

Both providers take core as a **peer** dependency: a backend or reporter is matched to its
task by object identity, and two copies of core are two incompatible sets of classes (the
same reasoning as [job-libraries.md](job-libraries.md)). They version independently of core and
declare a peer range on its major ([ADR 0002](adr/0002-npm-scope-and-versioning.md)).

`PvcBackend` stays in core, deliberately. It is the default when `TaskCacheSpec.backend` is
omitted and its `needsPvcWorkspace` drives workspace auto-registration in `TaskDef`, so core
depends on it structurally — it is this interface's reference implementation rather than a
bundled provider. See [cache-backends.md](cache-backends.md#why-one-is-in-core-and-one-is-not).

Inside `packages/tektonic` — and every bare `src/…` path in this document is relative to it:

```
src/
├── index.ts                  # the entire public API surface (re-exports)
├── constants.ts              # API versions, security contexts, default images/resources
└── lib/
    ├── core/                 # primitives + orchestrators + extension interfaces
    │   ├── param.ts  workspace.ts  result.ts        # named handles, stringify to $(...) exprs
    │   ├── task.ts                                   # TaskDef: the synthesizable unit of work
    │   ├── action.ts                                 # Action: reusable, typed work *inside* a pod
    │   ├── artifact.ts                               # TaskArtifact + ArtifactStore: files *across* pods
    │   ├── pipeline.ts  git-pipeline.ts             # graph discovery, validation, topo-sort
    │   ├── pipeline-task.ts                          # gated() per-edge overrides (when/retry/timeout)
    │   ├── condition.ts  changes.ts                  # typed rules DSL + onChanges detection
    │   ├── tektonic-project.ts                       # builds the SynthModel, runs the targets
    │   ├── hub-task-ref.ts                           # TaskLike that references an ArtifactHub task
    │   ├── cache-backend.ts  status-reporter.ts     # extension interfaces
    │   ├── synth-target.ts                           # extension interface: SynthTarget + SynthModel
    │   └── trigger.ts  trigger-events.ts            # provider-neutral firing config
    ├── script/               # ScriptLanguage plugins (sh/bash/nushell/python) + from-file
    ├── cache/                # PvcBackend + the cache helpers backend authors reuse
    └── targets/              # SynthTarget implementations
        ├── pac/              # PacTarget + every PAC concept: annotations, params, {{ }} bindings
        ├── tekton/           # TektonTarget: plain kind: Pipeline + kind: Task
        └── hub/              # HubTarget: Tekton catalog entries, the write side of HubTaskRef
```

Nothing under `core/` mentions PAC. `grep -r 'pipelinesascode\|PAC_' src/lib/core/` returning
nothing is the check that the seam has not leaked back. The provider seams need no such check:
the providers live in other repos and get core from npm, so its internals are out of reach.

Everything a consumer can touch is re-exported from `src/index.ts` — if it isn't there, it's
internal. Keep that file the single source of truth for the public surface.

## The synthesis flow

Nothing is emitted until a synthesizer runs. The pipeline:

1. **Construct primitives.** `Param`/`Workspace`/`Result` are inert handles; their `toString()`
   / `.path` getters produce Tekton interpolation expressions (`$(params.x)`,
   `$(workspaces.x.path)`, `$(tasks.t.results.r)`). This is why a tagged-template script can
   interpolate them directly.
2. **Construct tasks.** `TaskDef` (aliased as `Task`) stores steps, params, workspaces, caches,
   results, and an optional status reporter. The constructor does light wiring: it expands any
   composed `Action` into steps and merges what it contributes upward, merges a reporter's
   `requiredParams` into the task's params, auto-registers PVC cache workspaces, and binds each
   `Result` to the task name.
3. **Construct a pipeline.** `Pipeline` walks `task.needs` transitively (`discoverAllTasks`),
   detects status-reporting tasks and prepends a generated "set pending" task, and collects
   cache `finally` tasks. `GitPipeline` additionally creates the git-clone task and threads the
   shared workspace through every task.
4. **Build the model.** `TektonicProject` calls `pipeline._buildSpec()` per pipeline — which
   validates the graph, topologically sorts it, infers the param/workspace union and emits the
   spec — renders each unique `TaskDef.synth()` to a `Task` manifest (injected restore/save/
   reporter steps and script wrapping included), resolves the cache/ephemeral workspace
   bindings, and collects the run defaults. The result is a `SynthModel`: provider-neutral,
   built once.
5. **Emit.** Each `SynthTarget` is handed that model and writes files for its delivery
   mechanism. The default is `PacTarget`; cdk8s writes the YAML.

### Jobs and actions

The two units of reuse are deliberately different sizes, and the split follows what a pod costs:

- A **job** is a `TaskDef`: one Tekton Task, one pod, one node in the DAG, its own status
  context, `needs`, `when`, retries and timeout. A job library is a function from options to a
  `Task` ([job-libraries.md](job-libraries.md)).
- An **action** (`src/lib/core/action.ts`) is reusable work *inside* one pod: typed inputs,
  typed outputs, a version, rendering to one or more steps of the composing task. It is never a
  graph node and has no status of its own.

`defineAction` returns a factory; calling it yields an `Action` whose steps are already
name-prefixed (`<instance>-<step>`) and image-resolved, and whose declared outputs are
`ActionOutput` handles — the same `toString()` trick `Param`/`Workspace`/`Result` use, over an
in-pod path under `/tektonic/actions`. Because Tekton steps are separate containers, `TaskDef`
injects a pod-scoped `emptyDir` volume and mounts it via the `stepTemplate` whenever a composed
action declares outputs; that mount is what makes one step's output readable by the next.

Everything an action needs travels upward into the composing task — params, workspaces, caches,
volumes, results — with the task's own entries winning by name, mirroring how a
`StatusReporter`'s `requiredParams` merge. Everything cross-cutting flows downward: by synthesis
time an action's steps are ordinary steps, so the step template, pull policy, `taskPreset` step
defaults and the exit-code contract apply to them unchanged. An action cannot opt out of that
contract (`onError: 'stopAndFail'` in a reporting task is rejected at construction), which is
the same rule a raw `#!` body lives under.

Crossing the *pod* boundary is explicit: `output.toResult(result)` and
`output.toWorkspace(ws, dest?)` each return an action that copies the file, so the promotion is
a step the author chose rather than a silent framework behaviour. `toResult` enforces Tekton's
4KB result cap in the step instead of letting it truncate.

`output.toArtifact()` is the third promotion and the declared one. It goes in the task's
`produces` rather than its `steps`, because the workspace and store an artifact lives on are the
task's to know, not the action's; a plain path a hand-written step wrote may be declared the
same way. The resulting `TaskArtifact` is reached through its producer (`build.artifacts.dist`)
and stringifies to the path the *consumer* sees, so no step body hardcodes the layout. Vocabulary
is fixed: an **output** is always pod-internal, an **artifact** is always cross-pod, and
`toArtifact()` is the single point where one becomes the other.

`HubTaskRef` is the other "reusable unit from elsewhere", and it is job-sized: a remote catalog
Task, one more pod in the graph. The names are kept apart on purpose — an action is pod-internal
and never appears in the pipeline spec.

### Artifacts: a declared producer/consumer graph for files

`TaskDef` accepts `produces` (a record of name → source) and `consumes` (handles reached through
their producing task). Each declaration injects one step — publish at the end of the producer,
fetch at the start of the consumer — and both take the exit-code contract exactly as user steps
do, so a failed handoff reaches the reported status. That is the one place they differ from cache
steps, which run `onError: 'continue'` because a failed cache save must stay survivable.

The steps are not the point; the checks in `Pipeline` are. A consumer may only name an artifact
some task in the same pipeline produces, and the producing task must be a transitive `needs` of
the consumer — the case that is otherwise a runtime file-not-found, reported here as a synth-time
error that names both tasks and says which of the two mistakes it is. Declaring an artifact
nothing consumes only warns: publishing for a human to collect is legitimate.

Consuming does not create the graph edge. `needs` remains the only way to order tasks, and
`consumes` is checked against it rather than quietly adding to it — a file dependency that
silently reshaped the DAG would make the graph unreadable from the source.

### Dependency discovery, validation, ordering

`Pipeline` owns the graph logic in one place (`src/lib/core/pipeline.ts`):

- `discoverAllTasks` — DFS over `needs` to pull in transitive dependencies, so consumers only
  declare *direct* edges.
- `validate` — rejects duplicate task names and edges to tasks outside the pipeline.
- `topoSort` — orders tasks and throws on cycles.
- `inferParams` / `inferWorkspaces` — de-duplicated union across all tasks, so params/workspaces
  surface at the pipeline level automatically (params with a `pipelineExpression` are excluded —
  they're computed, not inputs).
- `runAfterFor` — computes each task's `runAfter`. It's `protected` and the single override point
  for subclasses.

### GitPipeline vs Pipeline

`GitPipeline` is the canonical example of an opinion layered on the base without polluting it:

- It creates a `git-clone` `TaskDef` (with `url`/`revision` params and eight git-metadata
  results) and a shared `workspace`.
- It **mutates user tasks idempotently**: adds the workspace if absent and sets a default
  `stepTemplate.workingDir` to the workspace path. Both are guarded so the same task instance can
  appear in multiple pipelines safely.
- It injects `git-clone` as a `runAfter` for root tasks by **overriding `runAfterFor`** — it
  never touches `task.needs`, preserving task reusability.

This is the pattern to follow for new opinionated pipeline types: subclass `Pipeline`, override
`runAfterFor`, mutate only idempotently.

### The synthesizer

`TektonicProject` is the composition, not the emitter: it builds the `SynthModel` and hands it to
its targets. `PacTarget`, the default, emits per-pipeline PAC `PipelineRun` templates with the
spec **inlined**, one `Task` file per unique task, and an optional `Repository` custom resource —
binding well-known params to PAC `{{ }}` variables. PAC (the operator) owns webhook delivery,
event matching, status reporting, and multi-provider support, so Tektonic has no
trigger/EventListener/RBAC code of its own. See [pac.md](pac.md).

The PAC-only options on `TektonicProjectOptions` (`repository`, `repoRelativePath`, `maxKeepRuns`,
`pacEventContext`) configure that default target. Passing `targets` replaces it, so a project that
wants both composes them explicitly:

```ts
new TektonicProject({
  namespace: 'ci',
  pipelines,
  targets: [new PacTarget({ repository: { url } }), new TektonTarget({ pipelineDir: 'plain' })],
});
```

## Extension points

Tektonic has five strategy interfaces. Adding a provider means implementing one — never editing
the core. Each is exported from `index.ts`.

### `SynthTarget` (`src/lib/core/synth-target.ts`)

Renders a `SynthModel` — pipeline specs, task manifests, workspace bindings, run defaults, with
no delivery-mechanism concepts in it — into files under an outdir, and returns what it wrote.
`PacTarget`, `TektonTarget` and `HubTarget` are the built-ins; a third party implements the
interface to emit a GitOps overlay, a different file layout or anything else. `HubTarget` is
worth reading as the worked example of a target that emits something other than runnable
manifests — a Tekton catalog tree, with its own validation and a generated README
([catalog.md](catalog.md)).

Two optional members let a target reach back into the model it will be handed:
`injectedParams` (params it binds on every run, so every pipeline spec must declare them — PAC's
`repo-full-name` and friends) and `injectedEnv` (environment it contributes to every step — PAC's
event context). The union across a project's targets is applied before any target emits, so one
model serves them all.

A target never receives PAC's annotations, `{{ }}` variables or `Repository` config; those are
`PacTarget`'s own options.

### `ScriptLanguage` (`src/lib/script/types.ts`)

Renders a step body: a shebang, a `wrap(body, ctx)` that adds a `log` preamble and honours the
exit-code contract (`ScriptCtx.captureExitCode` → write the worst code to `ctx.exitCodePath` and
re-exit), and a `lintCommand(file)` for the dev harness. Reuse via inheritance where possible —
`Bash` extends `Sh` and only changes the shebang. See [scripting.md](scripting.md).

`registerLanguage(lang, { extensions })` returns the language's tagged-template helper and is
the only way in — the four built-ins register through it at import time, so an out-of-tree
language reaches the same ergonomics: the tag, `languageFor`, the `{ language, body }` object
form, task and project `defaultLanguage`, `scriptFromFile`'s extension inference, and
`tektonic lint`'s file discovery. `LanguageName` is `KnownLanguageName | (string & {})`: open
to any registered name, still autocompleting the built-ins. A name may be registered once
(a second registration throws); a conflicting extension warns and the last one wins.

The one thing a language may not choose is the exit-code contract — a `wrap` that ignores
`captureExitCode` reports a failed step as green, silently. `assertExitCodeContract` from
`@tektonic-ci/core/testing` renders, executes and asserts it, so an out-of-tree language can
prove compliance; `src/lib/script/runtime.test.ts` is the same pattern written by hand.

### `CacheBackend` (`src/lib/core/cache-backend.ts`)

Returns a `restoreStep` and `saveStep` for a `TaskCacheSpec`, given a `BackendCtx` that carries
only the owning task's name and a project-level fallback image — nothing provider-specific, so a
new backend costs the core no change. A backend needing a more specific image owns that default
itself (the GCS backend does), and step images resolve `spec.image` → backend default →
`ctx.defaultImage`. `needsPvcWorkspace` tells `TaskDef` whether to auto-register the cache
workspace and wire finally-task workspaces — and is also what `TektonicProject` reads to
decide whether to bind a PVC, rather than matching on `type === 'gcs'` as it once did.
`PvcBackend` is the in-core reference implementation; `GcsBackend` ships in
`@tektonic-ci/cache-gcs`. The shared key-hashing and compression helpers in
`src/lib/cache/shared.ts` are exported from the package root as supported API for backend
authors — every backend needs the same hash semantics, and divergence there is a silent cache
miss. See [cache-backends.md](cache-backends.md).

### `ArtifactStore` (`src/lib/core/artifact.ts`)

Moves the bytes behind a declared `produces`/`consumes` relationship: `path(artifact)` for what
the consumer reads, a `publishStep` injected at the end of the producer, and a `fetchStep`
injected at the start of the consumer (return `undefined` when the store needs none). The same
restore/save shape as `CacheBackend`, and the same `ctx.defaultImage` resolution, deliberately —
but a separate interface, because a cache is content-addressed and reused across runs while an
artifact is run-scoped with exactly one writer, and forcing either through the other's contract
distorts both.

Everything above the seam is store-independent: the typed `TaskArtifact` handles, and the
synth-time checks in `Pipeline` that a consumer names an artifact something in the pipeline
produces and that the producer is a transitive `needs` of the consumer. Those checks — not the
copying — are what the primitive is for. `WorkspaceArtifactStore` is the in-core default and
keeps artifacts in a per-producer subtree of the ephemeral workspace, so each subtree has one
writer; it inherits that workspace's single-RWO-PVC constraint. `GcsArtifactStore`, in
`@tektonic-ci/cache-gcs`, is the implementation that lifts it: producer uploads, consumer
downloads, no workspace bound on either side. An optional `uri(artifact)` lets a store name a
location that outlives the pod, which is what artifact provenance records.

Swapping between them changes no `produces`/`consumes` declaration and no handle type — the
property the seam exists to have, and the one its tests assert. See
[artifacts.md](artifacts.md), [ADR 0001](adr/0001-artifacts-and-dependencies.md) and
[job-libraries.md](job-libraries.md#crossing-the-pod-boundary).

### `StatusReporter` (`src/lib/core/status-reporter.ts`)

Supplies `requiredParams`, a `createPendingTask(contexts)` (run first to mark everything pending),
and a `finalStep(context, userStepNames)` appended to each reporting task. The final step takes
the worst of two exit codes: `EXIT_CODE_PATH`, which the framework guarantees is populated
because reporting tasks render their user steps with exit-code capture and `onError: 'continue'`;
and `/tekton/steps/step-<name>/exitCode` for each named user step, which Tekton's own entrypoint
writes. The second source exists because the first is written *by the wrapped script*, so a body
calling nushell's untrappable `exit` terminates before the wrapper can persist anything and
leaves a stale `0`. Only the user steps are consulted — the injected cache steps also run with
`onError: 'continue'`, but a failed cache save must stay non-fatal. An optional
`startStep(context)` is prepended ahead of cache restore to report the pod as running; core
forces it to `onError: 'continue'` and keeps it out of the exit-code contract. There is no in-core
reporter: `GitHubStatusReporter` ships in `@tektonic-ci/reporter-github`, and core's own
tests use a fixture implementation of the interface (`src/__fixtures__/reporter.ts`) so what
they assert is the contract rather than GitHub's wire format. The optional
`createStatusReconcilerTask`/`createSkipResolverTask` pair is feature-detected by `Pipeline`;
[status-reporters.md](status-reporters.md) documents the whole method set for implementers.

## Key design decisions

- **Why cdk8s?** It gives a typed construct tree and battle-tested YAML emission, so Tektonic
  focuses on the Tekton domain model rather than on serialization.
- **Why template-literal interpolation for params/workspaces?** Tekton's `$(...)` expressions are
  just strings; making the handles `toString()` to those strings means interpolation needs no
  special API and composes naturally inside scripts.
- **Why discover dependencies transitively from `needs`?** Consumers declare intent (A needs B)
  once; the library derives the full graph and ordering. Tasks never carry pipeline-specific
  state, so a task instance is reusable across pipelines.
- **Why have the framework own the exit-code contract?** It's the kind of fiddly, copy-pasted
  plumbing that YAML CI makes ugly. Centralising it in the `ScriptLanguage` wrappers keeps
  consumer scripts clean and correct by construction. See [scripting.md](scripting.md#the-exit-code-contract-handled-for-you).

Longer-form decisions, with the options that lost and why, live in [adr/](adr/):

- [ADR 0001 — An artifacts/dependencies primitive](adr/0001-artifacts-and-dependencies.md):
  why declared subpaths on the shared workspace beat a store-backed artifact service for now,
  and why Tekton's own `artifacts` are provenance rather than transport.
- [ADR 0002 — npm scope and versioning under the tektonic-ci org](adr/0002-npm-scope-and-versioning.md):
  why the packages become `@tektonic-ci/*`, and why they continue the 2.x line with
  independent versions after the repo split.

## Testing

Tests use [vitest](https://vitest.dev/) and live next to source as `*.test.ts`. Two patterns
dominate:

- **Synthesis assertions** — construct primitives, build a spec, and assert on the resulting
  object shape (params inferred, `runAfter` correct, cycle rejected).
- **Script runtime** — render a body through a `ScriptLanguage.wrap`, execute it with the real
  interpreter, and assert the process exit code *and* the contract file
  (`src/lib/script/runtime.test.ts`). Guard each case with `it.skipIf(!has(interpreter))` to keep
  the suite hermetic.

Run `npm test`, and `tektonic lint` (or `npm run lint:scripts`) to lint any `.sh`/`.bash`/`.nu`/`.py` files under
`src/`.
