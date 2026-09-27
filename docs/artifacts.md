# Artifact Stores & Provenance

An **artifact** is a file one task publishes for another to read — declared in the producer's
`produces`, named in the consumer's `consumes`, and checked at synth time. How to *declare*
one is in [job-libraries.md](job-libraries.md#crossing-the-pod-boundary); this page is about
the two things behind the declaration: where the bytes go (`ArtifactStore`) and what gets
recorded about them (TEP-0147 artifact provenance).

Both are optional to think about. The default store needs no configuration, and provenance is
off unless you turn it on.

## The stores that ship

| Store | Package | Class | Factory | Storage | Needs a workspace |
|---|---|---|---|---|---|
| Workspace (default) | `@tektonic-ci/core` | `WorkspaceArtifactStore` | _(no factory; omit `artifactStore`)_ | a per-producer subtree of the pipeline's workspace | yes |
| GCS | `@tektonic-ci/cache-gcs` | `GcsArtifactStore` | `gcsArtifacts({ bucket, prefix?, … })` | a tarball per artifact in a GCS bucket | no |

`WorkspaceArtifactStore` stays in core for the same reason `PvcBackend` does: core depends on
it structurally. It is the default when `artifactStore` is omitted, and its `needsWorkspace` is
what makes `TaskDef` resolve a workspace for `produces` and auto-mount it on every consumer.
`GcsArtifactStore` has no such tie, so it ships outside — which is the only evidence this
interface supports an implementation written elsewhere. The same reasoning, at more length, is
in [cache-backends.md](cache-backends.md#why-one-is-in-core-and-one-is-not).

## Why you would swap the default

The workspace store copies within one PVC. That is cheap and needs no infrastructure, but it
inherits the PVC's constraint: a `ReadWriteOnce` volume can only be mounted on one node, so
every task sharing it is pinned to that node. A pipeline that wants its tasks scheduled freely
has to stop sharing a volume, and an artifact is usually the last thing forcing one.

`GcsArtifactStore` removes it. The producer uploads a tarball, the consumer downloads it, and
**neither task binds a workspace for the artifact at all**:

```typescript
import { gcsArtifacts } from '@tektonic-ci/cache-gcs';

const store = gcsArtifacts({ bucket: 'my-ci-artifacts', prefix: 'runs/' });

const build = new Task({
  name: 'build',
  steps: [compile],
  artifactStore: store,
  produces: { dist: compile.outputs.bundle.toArtifact() },
});

const test = new Task({
  name: 'test',
  needs: [build],
  consumes: [build.artifacts.dist],
  steps: [{ name: 'run', image, script: sh`tar xf ${build.artifacts.dist}` }],
});
```

Nothing above the store changed: same `produces`, same `consumes`, same `TaskArtifact` handle,
same synth-time checks. Only what `build.artifacts.dist` resolves to is different, and no step
body names it anyway.

Objects are keyed `gs://<bucket>/<prefix><run>/<producing task>/<artifact>.tar.zst`, where
`<run>` defaults to `$(context.pipelineRun.uid)`. That is what keeps one run from reading
another's artifacts — and it is why a store-backed artifact needs a PipelineRun.
`$(context.taskRun.uid)` would differ between producer and consumer, so it is not a fallback;
pass `runKey` if your cluster gives you something better.

### One constraint the workspace store hides

Steps are separate containers in one pod. They share *volumes*, not filesystems — so the
publish step tektonic injects can only read a file the user step left somewhere both mount.
The workspace store never has to say this, because it always has a workspace.

A store that needs none does. With `GcsArtifactStore`, the path in `produces` must be:

- an action output promoted with `.toArtifact()` — these live on the pod-scoped action volume,
  which is mounted on every step, so this always works and is the ergonomic choice; or
- a path under a workspace the task mounts anyway, `/tekton/home`, or a volume it declares.

Fetched artifacts land under `/tekton/home/artifacts/<producer>/<name>/` for the same reason:
it is the one directory Tekton mounts on every step.

## The `ArtifactStore` interface

```typescript
import type { ArtifactStore, ArtifactStoreCtx, TaskArtifact, TaskStepSpec } from '@tektonic-ci/core';

export class BucketStore implements ArtifactStore {
  readonly type = 'bucket';
  /** False, so `TaskDef` resolves no workspace and mounts none on consumers. */
  readonly needsWorkspace = false;

  constructor(private readonly opts: { bucket: string }) {}

  /** Where the consumer reads it — what `${build.artifacts.dist}` becomes. */
  path(a: TaskArtifact): string {
    return `/tekton/home/artifacts/${a.producerName}/${a.name}/${a.fileName}`;
  }

  /** Injected at the end of the producing task. */
  publishStep(a: TaskArtifact, ctx: ArtifactStoreCtx): TaskStepSpec {
    return { name: `publish-${a.name}-artifact`, image: ctx.defaultImage, script: … };
  }

  /** Injected at the start of a consuming task; return `undefined` for none. */
  fetchStep(a: TaskArtifact, ctx: ArtifactStoreCtx): TaskStepSpec | undefined {
    return { name: `fetch-${a.producerName}-${a.name}-artifact`, image: ctx.defaultImage, script: … };
  }

  /** Optional: a retrievable location, for provenance. Defaults to `file://` + `path()`. */
  uri(a: TaskArtifact): string {
    return `${this.opts.bucket}/${a.producerName}/${a.name}`;
  }
}
```

`ctx` carries the owning task's name (for error messages) and `defaultImage`, a marker
resolved at synth time against the project's `injectedStepImage`. Ask for what your steps
actually need with `injectedImageRef('gcloud', 'nushell', 'tar', 'zstd')` instead, and a
project whose image lacks one is told at synth time rather than at pod-run time.

Two things a store does *not* decide: the declaration and the checks. A consumer may only name
an artifact some task in the pipeline produces, and the producer must be a transitive `needs`
of the consumer — enforced in `Pipeline`, identically whichever store is in use.

`ArtifactStore` is deliberately **not** `CacheBackend`, despite the matching restore/save
shape. A cache is content-addressed and reused across runs, so it has a hash key, a miss and
an eviction policy; an artifact is run-scoped with exactly one writer, so a missing one is a
failure rather than a miss. Forcing either through the other's contract distorts both — the
full argument is in [ADR 0001](adr/0001-artifacts-and-dependencies.md). What they *do* share is
the script and compression plumbing: `cacheScript`, `threadFlag` and the language constants
from [cache-backends.md](cache-backends.md#helpers-core-publishes-for-backend-authors) are
supported API for store authors too, and `GcsArtifactStore` uses them.

## TEP-0147 artifact provenance

Separately from moving bytes, tektonic can record *what* each task read and wrote, as
`{uri, digest}` pairs in the TaskRun status. This is Tekton's own
[TEP-0147](https://github.com/tektoncd/community/blob/main/teps/0147-tekton-artifacts-phase1.md)
mechanism, and its consumer is [Tekton Chains](chains.md).

It moves no files. It is metadata *about* the files your `ArtifactStore` moved, and the two are
independent choices.

```typescript
new TektonicProject({
  namespace: 'ci',
  pipelines,
  artifactProvenance: true,     // or per task, which overrides this
});

const release = new Task({
  name: 'release',
  workspaces: [ws],
  steps: [build],
  produces: {
    image:    { from: 'out/image.tar', buildOutput: true },   // a subject of the attestation
    coverage: 'out/coverage.xml',                             // a byproduct
  },
});
```

Turning it on injects one `artifact-provenance` step at the end of each task that declares
artifacts. It digests what the task produced (at the path the producer wrote, not the archive
the store uploaded) and what it consumed, and writes one JSON document to
`$(step.artifacts.path)`, which the controller lifts into the TaskRun status.

**`buildOutput` is the bit that matters to Chains.** An output is a SLSA *byproduct* unless it
is marked, at which point Chains treats it as a **subject** — the thing the attestation is
about. Mark the release artifact; leave coverage reports, logs and SBOM side-files alone.
Consumed artifacts are recorded as `inputs`, which is how they become materials of the build.

Three things to know before enabling it:

- **It is alpha upstream.** Nothing reads the file unless your cluster's `feature-flags`
  ConfigMap sets `enable-artifacts: "true"`. That is why it is off by default: on a cluster
  without the flag you would gain a step per task and no provenance.
- **A failure here fails the task.** Unlike a cache save, this is not an optimisation. A claim
  about a build that silently fails to appear is the failure mode that makes attestation
  worthless, so a red task is the cheaper outcome.
- **The step needs `sha256sum`**, which is `sh`-level (busybox or coreutils both have it), so
  it resolves through the project's `injectedStepImage` with no extra capability.

Vocabulary: upstream calls these records "artifacts" too. In tektonic they are **artifact
provenance** in prose and `artifactProvenance` in the API, and a bare "artifact" is always the
cross-pod file. The disambiguation is fixed in [ADR 0001](adr/0001-artifacts-and-dependencies.md).

## Testing a store

`assertArtifactStoreConformance` covers the contract every store shares: paths with one
writer, step naming, `uri` shape, and publish/fetch placement. Run it in your tests, and against
`@tektonic-ci/core@next` (see [testing.md](testing.md#testing-a-provider-the-conformance-kit)).
The examples below are for what is specific to your store.

`synthTask` and `synthPipeline` from `@tektonic-ci/core/testing` render a task in memory, so a
store is testable without a cluster:

```typescript
const build = new Task({ name: 'build', steps: [compile], artifactStore: new BucketStore({ bucket: 's3://x' }),
                         produces: { dist: compile.outputs.bundle.toArtifact() } });

expect(build.workspaces).toEqual([]);                     // needsWorkspace: false was honoured
expect(synthTask(build).stepNames).toEqual(['compile', 'publish-dist-artifact']);
expect(`${build.artifacts.dist}`).toBe(build.artifacts.dist.path);
```

[`src/gcs-artifact-store.test.ts`](https://github.com/tektonic-ci/cache-gcs/blob/main/src/gcs-artifact-store.test.ts) in tektonic-ci/cache-gcs is the worked example, including
the assertion that swapping stores changes no `produces`/`consumes` declaration — which is the
property the seam exists to have. See [testing.md](testing.md).
