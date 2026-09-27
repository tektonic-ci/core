# Custom Cache Backends

Tektonic ships two cache backends, in two packages:

| Backend | Package | Class | Factory | Storage |
|---|---|---|---|---|
| PVC (default) | `@tektonic-ci/core` | `PvcBackend` | _(no factory; omit `backend`)_ | Kubernetes PersistentVolumeClaim |
| GCS | [`@tektonic-ci/cache-gcs`](https://github.com/tektonic-ci/cache-gcs) | `GcsBackend` | `gcs({ bucket, prefix?, image? })` | Google Cloud Storage bucket |

When `TaskCacheSpec.backend` is omitted, Tektonic uses `PvcBackend` automatically.

## Why one is in core and one is not

`PvcBackend` stays in core because core structurally depends on it. It is the default when
`TaskCacheSpec.backend` is omitted, and its `needsPvcWorkspace` is what makes `TaskDef`
auto-register the cache workspace on the task and prepend it to finally-task workspace
bindings. Core cannot synthesize a task without knowing about it, so it is the *reference
implementation* of this interface, not a bundled provider.

`GcsBackend` has no such tie, so it moved out to `@tektonic-ci/cache-gcs`. That is not
tidiness: it is the only evidence this interface supports an out-of-tree implementation. It
lives in its own repo, [tektonic-ci/cache-gcs](https://github.com/tektonic-ci/cache-gcs), and builds against `@tektonic-ci/core`
from npm, so it can reach nothing but the published surface — anything a third-party backend
needs and cannot reach breaks there first, in its CI, rather than in your project. Start from
it when writing a backend of your own.

The asymmetry is therefore deliberate: one backend core owns, one backend that proves the
seam. If you are weighing whether something belongs in core, `needsPvcWorkspace` is the test
— does core have to know about it to synthesize a task?

## Helpers core publishes for backend authors

Every backend that compresses hashes its key files and pipes archives through `zstd` the
same way. Diverge on the hash and you get silent cache misses rather than an error, so core
exports the pieces `GcsBackend` and `PvcBackend` both use:

| Export | What it does |
|---|---|
| `hashExpr(spec)` | The nushell expression computing a cache key hash from `spec.key` |
| `threadFlag(spec, defaultMulti?)` | `-T0`/`-T1` from `spec.multiThreadCompression` |
| `cacheScript(body, language)` | Wraps a step body in a `Script`, so the shebang and `log` preamble come from the language plugin rather than a hand-written heredoc |
| `stagedExtract(spec, label, extract)` | Extracts through a staging dir and swaps each path in, instead of `rm -rf`-ing a tree another task on the same workspace may be reading |
| `COMPRESSED_CACHE_LANGUAGE` / `PORTABLE_CACHE_LANGUAGE` | `'nushell'` and `'sh'` — the languages the built-in paths use |

These are supported API, and `@tektonic-ci/cache-gcs` consumes them through the package
root like any other caller. `cacheScript`, `threadFlag` and the language constants are useful
to `ArtifactStore` authors too — an artifact store compresses the same way, and `threadFlag`
is typed on the field it reads rather than on `TaskCacheSpec` so it can be called without one.
`hashExpr` and `stagedExtract` are cache-specific: an artifact is not content-addressed, and
has no live tree to extract over. See [artifacts.md](artifacts.md). Use them rather than reimplementing: `stagedExtract` in particular
encodes a production failure (a restore deleting a module cache while a concurrent task
compiled against it) that is invisible until it bites.

## The `CacheBackend` interface

To write a custom backend, implement `CacheBackend`:

```typescript
import type { CacheBackend, BackendCtx } from '@tektonic-ci/core';
import type { TaskCacheSpec, TaskStepSpec } from '@tektonic-ci/core';

/** Your backend's image default lives beside your backend, not in tektonic's core. */
const DEFAULT_S3_CACHE_IMAGE = 'ghcr.io/example/aws-cli:stable';

export interface S3BackendOptions {
  bucket: string;
  /** Overrides {@link DEFAULT_S3_CACHE_IMAGE} for this instance. */
  image?: string;
}

export class S3Backend implements CacheBackend {
  readonly type = 's3';
  readonly needsPvcWorkspace = false; // true only if your backend stores data on a PVC

  constructor(private readonly opts: S3BackendOptions) {}

  restoreStep(spec: TaskCacheSpec, ctx: BackendCtx): TaskStepSpec {
    return {
      name: `restore-${spec.name}-cache`,
      image: this.image(spec),
      script: `#!/bin/sh\necho "[s3] restore ${spec.name} for ${ctx.taskName} from ${this.opts.bucket}"`,
    };
  }

  saveStep(spec: TaskCacheSpec, ctx: BackendCtx): TaskStepSpec {
    return {
      name: `save-${spec.name}-cache`,
      image: this.image(spec),
      script: `#!/bin/sh\necho "[s3] save ${spec.name} for ${ctx.taskName} to ${this.opts.bucket}"`,
      onError: 'continue',
    };
  }

  private image(spec: TaskCacheSpec): string {
    return spec.image ?? this.opts.image ?? DEFAULT_S3_CACHE_IMAGE;
  }
}
```

## `needsPvcWorkspace`

Set `needsPvcWorkspace = true` when your backend reads/writes to a Kubernetes PVC (i.e. `spec.workspace`). Tektonic will then:

1. Auto-register `spec.workspace` on the task if it isn't already declared.
2. Prepend the cache workspace to finally-task workspace bindings so hash files survive pod boundaries.

Set it to `false` for remote-storage backends (GCS, S3, etc.) that don't need a local PVC.

## Using a custom backend

```typescript
const myBackend = new S3Backend({ bucket: 'my-ci-cache' });

const buildTask = new Task({
  name: 'build',
  steps: [{ name: 'run', image: 'node:22-alpine', command: ['npm', 'run', 'build'] }],
  caches: [{
    name: 'npm',
    key: ['package-lock.json'],
    paths: ['node_modules'],
    backend: myBackend,
  }],
});
```

## Checking an implementation

`assertCacheBackendConformance` from `@tektonic-ci/core/testing` checks a backend against what
core's synthesis relies on: step naming, `spec.image` precedence, and both save strategies.
Run it against `@tektonic-ci/core@next` too. See
[testing.md](testing.md#testing-a-provider-the-conformance-kit).

## `BackendCtx`

`restoreStep` and `saveStep` receive a `BackendCtx` carrying only what every backend
needs, whatever it stores archives in:

```typescript
interface BackendCtx {
  taskName: string;      // the task this cache is attached to
  defaultImage: string;  // project-level fallback step image
}
```

There is deliberately nothing provider-specific in it — no bucket, no cloud SDK image.
Adding a backend therefore requires no change to tektonic's core.

`taskName` is the name of the task the cache belongs to. For a
`saveStrategy: 'finally'` cache, which is rendered into its own pod, it is still the
*source* task's name, so hash files written by the restore step stay addressable across
the pod boundary.

### Image resolution

Step images resolve in one order, and every backend should honour it:

1. `spec.image` — the per-cache override on `TaskCacheSpec`.
2. Your backend's own default — an `image` option on your backend.
3. The project's `injectedStepImage`, reached either as `ctx.defaultImage` (which requires
   nothing beyond `sh`) or as `injectedImageRef(...capabilities)` when your steps need more.

Tektonic ships no image of its own: it generates every injected script and only expects the
image to *provide* what that script invokes. `injectedImageRef` is how a backend says which
interpreters and CLIs that is, so a project whose image lacks one is told at synth time:

```ts
private _image(spec: TaskCacheSpec, ctx: BackendCtx): string {
  // nushell + zstd for the compressed path; plain `sh` needs nothing extra.
  return spec.image ?? this.opts.image ?? (spec.compress
    ? injectedImageRef('nushell', 'zstd', 'tar')
    : ctx.defaultImage);
}
```

The built-ins follow it. `PvcBackend` has no image of its own: an uncompressed cache lands on
`ctx.defaultImage`, a compressed one asks for `nushell`/`tar`/`zstd`. `GcsBackend` asks for
those plus `gcloud`, and yields to `gcs({ bucket, image: 'ghcr.io/example/gcloud:pinned' })`
and then to `spec.image`. `DEFAULT_GCS_CACHE_IMAGE`, exported from
`@tektonic-ci/cache-gcs`, is one image known to satisfy the GCS set:

```ts
gcs({ bucket: 'my-ci-cache', image: DEFAULT_GCS_CACHE_IMAGE })
```

A project that names no capable image gets an error at synth time naming the missing
capability, rather than a `command not found` inside a pod minutes into a run.
