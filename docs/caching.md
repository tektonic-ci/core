# Caching

Caching speeds up builds by restoring dependency directories (`node_modules`, Go module/build
caches, tool databases) from a previous run. Declare a cache on a task and Tektonic injects a
**restore** step before your steps and a **save** step after them — you write no cache plumbing.

Hit/miss is hash-based: the SHA-256 of the `key` files determines the archive name, exactly like
GitLab CI's `cache:` keyword. Change a lockfile, get a fresh cache.

## Quick start (PVC backend)

The default backend stores archives on a Kubernetes PersistentVolumeClaim. Declare a cache
workspace, attach the cache to a task, and register the workspace's PVC with the project:

```typescript
import { Workspace, Task, TektonicProject } from '@tektonic-ci/core';

const nodeCache = new Workspace({ name: 'node-cache' });

const test = new Task({
  name: 'test',
  caches: [{
    name: 'node-modules',
    key: ['package-lock.json'],          // hash of these files = cache key
    paths: ['node_modules'],             // restored on hit, saved on miss
    workspace: nodeCache,                // PVC the archive lives on
    compress: true,                      // single .tar.zst archive (recommended)
    workingDir: '$(workspaces.workspace.path)',
  }],
  steps: [{ name: 'test', image: nodeImage, script: nu`npm ci; npm test` }],
});

new TektonicProject({
  name: 'app',
  namespace: 'ci',
  pipelines: [pipeline],
  caches: [{ workspace: nodeCache, storageSize: '5Gi', storageClassName: 'local-path' }],
});
```

The cache workspace is auto-registered on the task — you don't add it to the task's
`workspaces` yourself. Register the PVC with whichever synthesizer you use: `TektonicProject` or
[`TektonicProject`](pac.md#workspaces-and-caches), both via their `caches` option.

## GCS backend

On GKE you can skip PVCs entirely and store archives in a Google Cloud Storage bucket,
authenticated via Workload Identity. There's no workspace and nothing to register with the
project:

```typescript
import { gcs } from '@tektonic-ci/cache-gcs';  // npm install @tektonic-ci/cache-gcs

caches: [{
  name: 'node-modules',
  key: ['package-lock.json'],
  paths: ['node_modules'],
  backend: gcs({ bucket: 'my-ci-cache', prefix: 'node/' }),
  compress: true,
  workingDir: '$(workspaces.workspace.path)',
}]
```

Bind the PipelineRun ServiceAccount to a GCP service account with bucket access via a
GKE Workload Identity annotation on that ServiceAccount (created out of band — PAC runs
PipelineRuns under it but does not create it). GCS defaults to multi-threaded compression and a
higher compression level than PVC, since it targets environments with spare CPU.

## Cache options

All fields live on `TaskCacheSpec` (the entries in a task's `caches` array):

| Field | Default | Description |
|-------|---------|-------------|
| `name` | required | Names the injected steps (`restore-<name>-cache` / `save-<name>-cache`) |
| `key` | required | Files whose combined content sets the cache key. `[]` = fixed hash (always hits after the first run) |
| `paths` | required | Paths (relative to `workingDir`) to restore on hit and save on miss |
| `workspace` | — | PVC for the archive. Required for PVC backend; ignored for GCS |
| `backend` | PVC | `gcs({ bucket, prefix?, image? })` from `@tektonic-ci/cache-gcs`, or any custom `CacheBackend` |
| `workingDir` | — | Base dir for `key`/`paths`; usually `$(workspaces.workspace.path)` |
| `image` | backend default | Image for the injected restore/save steps. Falls back to the backend's own default, then to the project's `injectedStepImage` — see [cache-backends.md](cache-backends.md#image-resolution) |
| `compress` | `false` | Pack into one `.tar.zst` archive instead of copying file trees |
| `compressionLevel` | `1` (PVC) / `3` (GCS) | zstd level 1–19 |
| `multiThreadCompression` | `false` (PVC) / `true` (GCS) | `-T0` (auto threads) vs `-T1` |
| `maxEntries` | `3` | Archives kept per workspace; `0` disables eviction |
| `forceSave` | `false` | Always overwrite the archive (for tool-managed DBs, e.g. grype) |
| `saveStrategy` | `'step'` | `'finally'` runs save in a separate pod — see below |
| `computeResources` | stepTemplate default | CPU/memory for the injected cache steps |

### One producer, many consumers

If one task warms a cache on a shared workspace and later tasks reuse it, declare it once with
`warmCache(spec)` and give tasks `.producer` or `.consumer({ forceSave? })`. Each consumer skips
restore when the paths already exist. Synthesis fails when a consumer's producer is missing or
not ordered before it. See [agent-guide.md](agent-guide.md#one-producer-many-consumers-warmcache).

### Compression

`compress: true` collapses thousands of small file operations into a single archive
read/write — a large win on NFS/PVC storage. It requires the step image to provide `tar` with
`--zstd`, `zstd` and nushell, so the project must name one in `injectedStepImage` (or the cache
its own `image`): tektonic's neutral fallback provides `sh` and `git` only, and synthesis fails
naming the missing capability rather than letting the step die in the pod. Lower `compressionLevel` for less CPU/memory;
level 1 still achieves roughly 2.5× compression with ~1 MB of working memory.

### `saveStrategy: 'finally'`

By default the save step runs inside the build pod, sharing its memory. For memory-intensive
builds on constrained nodes (e.g. large Go projects), that can OOM during compression. Set
`saveStrategy: 'finally'` to run the save in a **separate** Tekton `finally` task — the build
pod terminates and frees its memory before compression starts. Costs ~10–15 s of scheduling
overhead. Tektonic generates and wires the finally task automatically.

### Fixed-hash caches

An empty `key: []` produces a constant hash, so the cache always hits after the first run. This
suits tool-managed data that isn't keyed by a lockfile — for example a vulnerability database
that a scanner updates in place. Combine with `forceSave: true` and `maxEntries: 1`:

```typescript
caches: [{
  name: 'grype-db',
  key: [],            // always hits after first run
  paths: ['grype-db'],
  backend: gcs({ bucket: 'my-ci-cache', prefix: 'grype/' }),
  forceSave: true,    // scanner updates the DB in place; always re-save
  maxEntries: 1,
  workingDir: '$(workspaces.workspace.path)',
}]
```

## Custom backends

To cache to S3, an OCI registry, or anything else, implement the `CacheBackend` interface — see
[cache-backends.md](cache-backends.md).
