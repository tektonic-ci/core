# Changelog

Notable changes to `@tektonic-ci/core`. Up to 2.1.0 the provider packages lived in this repo
and versioned together with core, so the entries below cover them too. From 2.1.1 they
release from their own repos and log changes there:
[reporter-github](https://github.com/tektonic-ci/reporter-github/blob/main/CHANGELOG.md),
[cache-gcs](https://github.com/tektonic-ci/cache-gcs/blob/main/CHANGELOG.md). This file starts
at the first change after 2.0.0; earlier history is in the git log.

## Unreleased

### Changed: this repo holds core only

`@tektonic-ci/reporter-github` and `@tektonic-ci/cache-gcs` moved to
[tektonic-ci/reporter-github](https://github.com/tektonic-ci/reporter-github) and
[tektonic-ci/cache-gcs](https://github.com/tektonic-ci/cache-gcs), history included, and
publish from there. Nothing about `@tektonic-ci/core`'s API or output changes. The
`lint:imports` check and `scripts/check-provider-imports.mjs` are gone: a provider built
against core from npm cannot deep-import it in the first place.

### Added: a public API check

`npm run api:check` (self-CI's `check-api` step) fails a change that breaks
`@tektonic-ci/core`'s public API against the last published release, unless the break is
declared under a `### Breaking` heading here, and then holds the release to a new major. It
does this without building any provider. `packages/tektonic/api/` records the API as a
reviewed report. See CONTRIBUTING's "Public API changes".

### Added: a conformance kit for providers

`@tektonic-ci/core/testing` exports `assertStatusReporterConformance`,
`assertCacheBackendConformance` and `assertArtifactStoreConformance`. Each drives a
status reporter, cache backend or artifact store through core's own synthesis and fails, naming
the broken contract, where the implementation does something core relies on it not to. Core
now publishes prereleases on the npm `next` dist-tag, so a provider's CI can run the kit
against `@tektonic-ci/core@next` and catch a behavioural break before it's released. See
docs/testing.md, "Testing a provider".

## 2.1.0

### Renamed: the packages are now published under `@tektonic-ci`

The repo moved to the `tektonic-ci` GitHub org (`tektonic-ci/core`), and the packages moved
to the npm scope that matches it ([ADR 0002](docs/adr/0002-npm-scope-and-versioning.md)):

| Was | Now |
|---|---|
| `@pfenerty/tektonic` | `@tektonic-ci/core` |
| `@pfenerty/tektonic-reporter-github` | `@tektonic-ci/reporter-github` |
| `@pfenerty/tektonic-cache-gcs` | `@tektonic-ci/cache-gcs` |

The API is unchanged apart from the entries below, so migrating is a rename. Change the
dependency names in `package.json` and every import, including subpaths:
`@pfenerty/tektonic/testing` becomes `@tektonic-ci/core/testing`. The CLI binary is still
`tektonic`. The providers' peer dependency is now `@tektonic-ci/core` `^2`. The
`@pfenerty/*` packages get no further releases and are deprecated in favour of these.

### Fixed: reporters differing only in `failOnError` no longer duplicate the pending and reconcile tasks

A pipeline used to build one `set-status-pending-*` and one `reconcile-status-*` task per
reporter *instance*, so a project with a strict and a report-only `GitHubStatusReporter` got a
second pair suffixed `-2` — two extra pods on every run, even though `failOnError` only changes
each task's own final step. Reporters now expose an optional `pendingGroupKey()`; tasks whose
reporters share a class and a key share one pending and one reconcile task, and each still
takes its final step from its own reporter. `GitHubStatusReporter`'s key covers everything but
`failOnError`. A reporter that does not implement it keeps a group per instance, as before.

Re-synthesize after upgrading: the `-2` task files are no longer emitted, and the unsuffixed
ones gain the contexts they held.

### Changed: `GitHubStatusReporter` pending and reconcile tasks run one step

`set-status-pending-*` and `reconcile-status-*` used to carry one step, and so one container,
per context. Each is now a single step, `pending` or `reconcile`, that loops over the
contexts. It still POSTs every one before failing and exits 1 once at the end if any failed,
so one failed POST can't leave the rest unset. `pendingTaskComputeResources` now sizes that
one step. Anything matching the old per-context step names (`pending-<context>`,
`resolve-<context>`) has to move to the new ones.

## 2.0.1

First release from the workspace layout, and the first of the provider packages.
`@pfenerty/tektonic@2.0.0` on npm was published by mistake from a stale pre-split tree and is
deprecated; everything below is new relative to it.

### Added: `HubTarget` — publish Tekton catalog entries, don't just consume them

`HubTaskRef` has always been able to *reference* a task someone else published. `HubTarget` is
the other half: a task that carries `catalog` metadata is emitted as a catalog entry, in the
layout a catalog repository expects.

```typescript
const clone = new Task({
  name: 'git-clone',
  catalog: {
    version: '0.1',
    description: 'Clones a git repository onto a workspace and reports its metadata.',
    categories: ['Git'],
    tags: ['git', 'clone'],
  },
  params: [url],
  steps: [/* … */],
});

new TektonicProject({ namespace: 'ci', pipelines, targets: [new PacTarget(), new HubTarget()] });
```

```bash
tektonic synth --target hub --outdir catalog
# catalog/task/git-clone/0.1/git-clone.yaml
# catalog/task/git-clone/0.1/README.md
```

The entry is the manifest every other target emits with everything local to *this* repository
taken back off it — no namespace, no project name prefix, no PAC annotations — plus the catalog
metadata as `tekton.dev/*` annotations, an `app.kubernetes.io/version` label and a
`spec.description`. The README beside it is generated from the task's own params, results and
workspaces, because a hand-written catalog README is stale the first time a param is added.

Each entry is validated at synth time, with every problem reported at once: a param or result
with no description, an image from a registry a consumer cannot pull anonymously, a category the
hub does not know, a version that is not `major.minor[.patch]`. The hub's own checks run once a
pull request is already open against the catalog repository, which is a slow way to learn that a
param has no description.

Publication itself stays outside the tool — a catalog entry is landed by a pull request — which
is why this is `synth --target hub` and not a `publish` command.

New API: `HubTarget`, `HubTargetOptions`, `CatalogMetadata`, `CatalogCategory`,
`CATALOG_CATEGORIES`, `DEFAULT_CATALOG_PLATFORMS`, `DEFAULT_MIN_PIPELINES_VERSION`,
`PUBLIC_REGISTRIES`, `catalogProblems`, `catalogReadme`, `registryOf`,
`TaskOptions.catalog`, `GitPipelineOptions.cloneCatalog`, `BuiltTask.catalog`. See
[docs/catalog.md](docs/catalog.md).

### Added: `tektonic synth --target <name>`

Narrows a synthesis to targets the project already declares, comma-separated for several. It
never *adds* a target — naming one the project does not declare fails, listing what it has,
rather than writing an empty outdir. `check` takes no `--target`: it compares a whole outdir, so
a filtered synthesis would report every other target's files as orphans.

The `git-clone` task `GitPipeline` generates now describes its `url` and `revision` params, so
the emitted manifests gain two `description` fields. Re-run `tektonic synth` and commit.

### Added: artifacts — a declared producer/consumer relationship for files

A task may now declare the files it publishes and the files it reads, and tektonic checks the
wiring at synth time:

```typescript
const build = new Task({
  name: 'build',
  workspaces: [workspace],
  steps: [compile],
  produces: { dist: compile.outputs.bundle.toArtifact(), report: 'target/report.xml' },
});

const test = new Task({
  name: 'test',
  needs: [build],
  consumes: [build.artifacts.dist],
  steps: [{ name: 'run', image, script: sh`tar xf ${build.artifacts.dist}` }],
});
```

`build.artifacts.dist` is a `TaskArtifact`: it stringifies to the path the *consumer* reads, so
no step body hardcodes the storage layout. A publish step is injected at the end of the
producer and a fetch step at the start of the consumer.

The copying is incidental; the declaration is the product. Three things now fail or warn at
synth time that were a runtime file-not-found before:

- consuming an artifact no task in the pipeline produces — an error naming the artifact and the
  consumer;
- consuming one whose producer is *present but not ordered first* — a separate error that says
  so, because "missing" and "unordered" are different mistakes with different fixes. Consuming
  does not create the edge: `needs` is still the only way to order tasks, and `consumes` is
  checked against it rather than quietly reshaping the graph;
- declaring an artifact nothing consumes — a warning, not an error. Publishing for a human to
  collect is legitimate.

Unlike a failed cache save, a failed publish or fetch fails the task, and in a reporting task
it reaches the reported status: a cache is an optimisation, an artifact is a handoff a
downstream task is counting on.

Where the bytes go is behind a new `ArtifactStore` seam, the fifth strategy interface.
`WorkspaceArtifactStore` is the default and keeps them in a per-producer subtree of the
workspace the pipeline already binds — one writer per subtree, which a bare agreed-upon path
does not give you. Setting `artifactStore` swaps the transport without touching the
declaration, the handle types or the checks.

`toWorkspace()` is unchanged and stays the undeclared escape hatch for a file nobody in the
pipeline consumes. New API: `TaskOptions.produces`/`consumes`/`artifactWorkspace`/
`artifactStore`, `TaskDef.artifacts`, `TaskArtifact`, `ActionOutput.toArtifact()`,
`ArtifactStore`, `ArtifactStoreCtx`, `WorkspaceArtifactStore`, `ARTIFACT_DIR`. Nothing is
removed and no existing synthesis changes. See
[docs/adr/0001-artifacts-and-dependencies.md](docs/adr/0001-artifacts-and-dependencies.md) for
the design and the options that lost.

### Breaking: the GCS backend and the GitHub reporter are separate packages

`GcsBackend`/`gcs`/`DEFAULT_GCS_CACHE_IMAGE` and `GitHubStatusReporter`/`statusParam` are no
longer exported from `@pfenerty/tektonic`. They now ship as:

| Was | Is |
|---|---|
| `import { gcs, DEFAULT_GCS_CACHE_IMAGE } from '@pfenerty/tektonic'` | `import { gcs, DEFAULT_GCS_CACHE_IMAGE } from '@pfenerty/tektonic-cache-gcs'` |
| `import { GitHubStatusReporter, statusParam } from '@pfenerty/tektonic'` | `import { GitHubStatusReporter, statusParam } from '@pfenerty/tektonic-reporter-github'` |

**Migration is one `npm install` and one import line per file.** Both packages take
`@pfenerty/tektonic` as a peer dependency, version together with it, and the synthesized YAML
is byte-identical.

```bash
npm install @pfenerty/tektonic-cache-gcs @pfenerty/tektonic-reporter-github
```

The reason is verification, not tidiness. `CacheBackend`, `StatusReporter` and `ScriptLanguage`
were all designed by someone consuming them from *inside* the same package, so nothing showed
whether they supported an implementation written outside it. Moving the two built-in providers
out — to packages that may import only the published surface, enforced by
`scripts/check-provider-imports.mjs` at build time — turns that from an assumption into a check.
It found two real defects, both fixed below.

`PvcBackend` deliberately stays in core: it is the default when `TaskCacheSpec.backend` is
omitted and its `needsPvcWorkspace` drives workspace auto-registration in `TaskDef`, so core
depends on it structurally. It is this interface's reference implementation rather than a
bundled provider. See [docs/cache-backends.md](docs/cache-backends.md#why-one-is-in-core-and-one-is-not).

#### Fixed on the way

- **`TektonicProject` decided whether to bind a cache PVC by matching `backend.type === 'gcs'`.**
  Any out-of-tree remote backend — S3, Azure Blob, anything — got a PVC bound that it never
  used. It now reads `needsPvcWorkspace`, which is what the interface has for exactly this.
- **`stepExitCodePath` was unexported.** A `StatusReporter` implemented outside the package
  could read the in-script contract file but not Tekton's own per-step exit codes, so a step
  body calling `exit` directly reported green. It is exported now, and
  [docs/status-reporters.md](docs/status-reporters.md) explains why both sources are needed.

#### Cache helpers are now supported API

`cacheScript`, `hashExpr`, `threadFlag`, `stagedExtract`, `COMPRESSED_CACHE_LANGUAGE` and
`PORTABLE_CACHE_LANGUAGE` are exported from the package root. Extracting the GCS backend forced
the choice between publishing them and duplicating them; publishing is right, because every
backend needs the same key-hash semantics and a divergent hash is a silent cache miss rather
than an error.

#### Also moved

- `DEFAULT_GCS_COMPRESSION_LEVEL` is no longer a core constant — it is GCS's own default and
  now lives in `@pfenerty/tektonic-cache-gcs`. Per-cache `compressionLevel` is unchanged.
- The repository is now an npm workspace. Contributors run every command from the root; see
  [CONTRIBUTING.md](CONTRIBUTING.md). Consumers are unaffected beyond the import changes above.

### Added

- `@pfenerty/tektonic-cache-gcs` and `@pfenerty/tektonic-reporter-github`.
- `stepExitCodePath` and the cache-author helpers listed above, exported from the package root.
- [docs/status-reporters.md](docs/status-reporters.md) — the full `StatusReporter` method set,
  including the optional/deprecated `createStatusReconcilerTask`/`createSkipResolverTask` pair
  that `Pipeline` feature-detects between, documented well enough to implement from outside.
- `npm run lint:imports` — fails the build on a deep import or a relative path from a provider
  package into core. `npm test` runs it first.

### Breaking: injected-step images come from the project, not from a module constant

The steps tektonic injects — git clone, cache restore/save, status reporting, change
detection — no longer default to `ghcr.io/pfenerty/apko-cicd/base:stable` (or, for GCS
caches, `ghcr.io/pfenerty/apko-cicd/gcloud:563.0.0`). Installing the library never silently
pulls from another project's registry: in a cluster whose pull secrets do not cover it, every
injected step failed with an image-pull error naming a repository the user had never heard of.

Instead, each injected step resolves its image in one documented order — the step's own
image → the component's default → the project's new `injectedStepImage` →
`DEFAULT_INJECTED_STEP_IMAGE`, a neutral public image providing `sh` and `git` only.

Because that fallback is minimal, a feature needing more now fails **at synth time** with a
message naming the capability (`nushell`, `tar`, `zstd`, `gcloud`), rather than at pod-run
time with `command not found`. Compressed caches, GCS caches and `GitHubStatusReporter` are
the features this affects.

**Both old constants are still exported, so an existing project opts back in with one line:**

```ts
new TektonicProject({
  // …
  injectedStepImage: DEFAULT_BASE_IMAGE,                    // clone, caches, reporter
  caches: [{ /* … */ backend: gcs({ bucket, image: DEFAULT_GCS_CACHE_IMAGE }) }],
});
```

Synthesized YAML is byte-identical with those two lines in place.

An image can instead declare what it provides, and tektonic checks it:

```ts
injectedStepImage: { image: 'ghcr.io/acme/ci-base:1.4.0', provides: ['sh', 'git', 'nushell'] }
```

A bare string is taken at its word — synthesis stays offline and never probes a registry.

### Script languages are an open registry

`ScriptLanguage` was documented as an extension point but was only half open: a third party
could construct `new Script(myLanguage, body)` and nothing else. The name union and the
extension map at `packages/tektonic/src/lib/script/` were both closed, so a registered language could not reach
`scriptFromFile`, the `{ language, body }` object form, task or project `defaultLanguage`, or
`tektonic lint`'s file discovery.

`registerLanguage(lang, { extensions })` opens it, and returns the language's tagged-template
helper so registration and use are one step:

```ts
export const rb = registerLanguage(new Ruby(), { extensions: ['.rb'] });
// then: script: rb`puts "hi"`
```

The four built-ins register through the same function at import time — there is no privileged
path into the registry. A name may be registered once (a second registration throws rather
than overriding at a distance); a conflicting extension warns and the last one wins.

`LanguageName` is now `KnownLanguageName | (string & {})`: any registered name type-checks
where a built-in does, and `'nushell'` still autocompletes. The only source-compatible break
is a `@ts-expect-error` on a call like `languageFor('ruby')` — that is a runtime error now,
not a type error.

`@pfenerty/tektonic/testing` gained `assertExitCodeContract(language, opts)` and
`interpreterAvailable(bin)`. The exit-code contract is the one thing a language may not
choose: a `wrap` that ignores `ctx.captureExitCode` reports a failed step as green. The
helper renders a body, runs it with the real interpreter, and asserts both the process exit
code and the contract file.

### Breaking: `TaskDef.synth` takes an options object

`synth(scope, namespace, namePrefix?, stepSecurityContext?, defaultLanguage?, defaultImagePullPolicy?)`
became `synth(scope, namespace, opts?: TaskSynthOptions)` with those fields named. Callers
passing only `(scope, namespace)` — and everyone going through `TektonicProject` or the
testing helpers — are unaffected.

### Added

- `injectedImageRef(...capabilities)`, `ImageCapability`, `InjectedStepImage`,
  `InjectedStepImageSpec` and `DEFAULT_INJECTED_STEP_IMAGE` are exported: a third-party cache
  backend, reporter or other injector declares what its steps need instead of hardcoding an
  image, and inherits the project's choice. The two extracted provider packages are the first
  out-of-tree consumers of it.
- `DEFAULT_GCS_CACHE_IMAGE` is exported — from `@pfenerty/tektonic-cache-gcs`'s root,
  per the package split above.
- `SynthOptions.injectedStepImage` in `@pfenerty/tektonic/testing`.
- `registerLanguage`, `unregisterLanguage`, `registeredLanguageNames`,
  `registeredExtensions`, `languageNameForExtension`, and the `KnownLanguageName`,
  `ScriptTag` and `RegisterLanguageOptions` types.
- `assertExitCodeContract` and `interpreterAvailable` in `@pfenerty/tektonic/testing`.
- `tektonic lint` discovers files from the language registry: `lintableExtensions()` replaces
  the `LINTABLE_EXTENSIONS` constant in `packages/tektonic/src/cli/lint.ts`.

### Changed

- `DEFAULT_GCS_CACHE_IMAGE` now pins `ghcr.io/pfenerty/apko-cicd/gcloud:581.0.0` (was
  `563.0.0`). The tag had been bumped in this repo's synthesized manifests but not in the
  constant that generates them; Renovate now updates the constant itself — at its new home in
  `packages/tektonic-cache-gcs/` — so the two cannot diverge again. See [CONTRIBUTING](CONTRIBUTING.md#dependency-updates).
