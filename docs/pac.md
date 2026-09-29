# Pipelines as Code (PAC)

[`TektonicProject`](agent-guide.md#tektonicproject) is Tektonic's synthesizer, and PAC is the
target it emits for by default. It generates
[Pipelines as Code](https://pipelinesascode.tekton.dev/) artifacts that live in your repo and
are read directly from the pushed commit at runtime — no EventListener, no RBAC, no Flux sync
race, and the pipeline that runs is always exactly what was committed. PAC also handles webhook
delivery, event matching, status reporting, and multi-provider support (GitHub, GitLab,
Bitbucket, Gitea) for you.

**Requires** the PAC operator installed in the cluster.

## What it generates

```typescript
import { GitPipeline, TektonicProject, TRIGGER_EVENTS } from '@tektonic-ci/core';

new TektonicProject({
  name: 'ocidex',
  namespace: 'ocidex-ci',
  pipelines: [pushPipeline, prPipeline, tagPipeline],
  outdir: '../.tekton',
  repoRelativePath: '.tekton',
});
```

This writes:

- `<outdir>/tasks/<task>.k8s.yaml` — one `Task` file per unique task across all pipelines
  (including `finally` tasks).
- `<outdir>/<pipeline>.k8s.yaml` — one PAC-annotated `PipelineRun` template per pipeline that
  has a `trigger`. The pipeline spec is **inlined** into the PipelineRun (`pipelineSpec`), and the
  task files are referenced via the `pipelinesascode.tekton.dev/task` annotation.

Only pipelines with a `trigger` are emitted.

## Trigger & rules

A pipeline's `trigger` decides **whether the whole PipelineRun fires** for an event. It's a list
of **rules** (OR-ed together); each rule names its own event(s) and branch/path filters (which AND
together). This is *pipeline-level* — distinct from the job-level `when`/`onChanges`/`fanOut` rules
that gate individual tasks *inside* a run (see the [agent guide](agent-guide.md#rules--conditions)).

```typescript
// simplest — every push:
const push = new GitPipeline({ name: 'push', trigger: { rules: [{ on: TRIGGER_EVENTS.PUSH }] }, tasks });

// PRs merging into main, only when src changed:
const ci = new GitPipeline({
  name: 'ci',
  trigger: { rules: [{ on: TRIGGER_EVENTS.PULL_REQUEST, branch: 'main', pathsChanged: ['src/**'] }] },
  tasks,
});

// compound — always on main, feature branches only when src/deps changed:
const monorepo = new GitPipeline({
  name: 'monorepo',
  trigger: {
    rules: [
      { on: [TRIGGER_EVENTS.PUSH, TRIGGER_EVENTS.PULL_REQUEST], branch: 'main' },
      { on: TRIGGER_EVENTS.PUSH,         branch: 'feature/*',       pathsChanged: ['src/**'] },
      { on: TRIGGER_EVENTS.PULL_REQUEST, sourceBranch: 'feature/*', pathsChanged: ['src/**'] },
    ],
    comment: '^/ci',           // also start on a `/ci` PR comment
    cancelInProgress: true,    // supersede older runs of this PR
  },
  tasks,
});
```

**Rule fields** (`TriggerRule`):

| Field | Meaning | Maps to |
|-------|---------|---------|
| `on` | event(s) this rule matches (required) | PAC `event` / `on-event` |
| `branch` | the branch the event concerns — **pushed** branch (push) or **target/into** branch (PR). Glob(s) | `on-target-branch` / `target_branch` |
| `sourceBranch` | PR **head/from** branch. Glob(s) | `source_branch` (CEL only) |
| `pathsChanged` | run only if changed files match these globs | `on-path-changed` / `files.all` |
| `pathsIgnored` | skip when only these changed | `on-path-change-ignore` |
| `cel` | raw PAC CEL fragment, AND-ed into the rule | — |

**Trigger fields** (`PipelineTrigger`): `rules` (required), `comment` (`on-comment` regex),
`labels` (`on-label`), `cancelInProgress` (`cancel-in-progress`), and `cel` (raw whole-expression
`on-cel-expression`, used instead of `rules`).

**Branch semantics.** `branch` is unambiguous because each rule names its event: for `push` it's the
pushed branch; for `pull_request` it's the **target** (merge-into) branch. Use `sourceBranch` for the
PR **head** (merge-from). For a `TAG` rule `branch` filters the tag name: `branch: 'v*'` matches
`refs/tags/v*` (a glob already starting `refs/tags/` is used as-is), and without one it fires on every tag.

**How it compiles.** A single rule with only `on`/`branch`/`pathsChanged` emits discrete
`on-event`/`on-target-branch`/`on-path-changed` annotations (no CEL). Anything compound — multiple
rules, any `sourceBranch`, `cel`, or a rule mixing `TAG` with another event — compiles to a single `on-cel-expression` (evaluated by the PAC
operator; no Tekton feature flag). `comment`/`labels`/`cancelInProgress` always emit as their own
annotations.

## Param bindings

PAC injects template variables at trigger time. `TektonicProject` binds well-known pipeline params to
those variables automatically, so a task that declares e.g. a `url` param receives the repo URL
with no extra wiring:

| Param | PAC template variable |
|-------|-----------------------|
| `url` | `{{ repo_url }}` |
| `revision` | `{{ revision }}` |
| `project-name` | `{{ repo_name }}` |
| `repo-full-name` | `{{ repo_owner }}/{{ repo_name }}` |
| `source-branch` | `{{ source_branch }}` |

`project-name`, `repo-full-name`, and `source-branch` are added as pipeline params
automatically. `url` and `revision` are the params `GitPipeline` already creates for its
git-clone task — so a `GitPipeline` + `TektonicProject` combination is wired end-to-end with no
manual params. Any param without a known binding is emitted with an empty value for you to fill
in.

## Workspaces and caches

Each `PipelineRun` gets workspace bindings derived from the inlined spec:

- Cache workspaces (those listed in `caches`) bind to a persistent PVC by `claimName`
  (`<name>-<workspace>` when a project `name` prefix is set, else the workspace name).
- Every other workspace binds to an ephemeral `volumeClaimTemplate`, sized by
  `workspaceStorageSize` (default `1Gi`) with optional `workspaceStorageClass`.

GCS-backed caches need no PVC and are filtered out of the workspace bindings.

```typescript
new TektonicProject({
  name: 'ocidex',
  namespace: 'ocidex-ci',
  pipelines: [pushPipeline, prPipeline, tagPipeline],
  outdir: '../.tekton',
  repoRelativePath: '.tekton',
  serviceAccountName: 'default',
  workspaceStorageSize: '5Gi',
  workspaceStorageClass: 'local-path',
  defaultPodSecurityContext: { runAsUser: 1024, runAsGroup: 1024, fsGroup: 1024 },
  caches: [
    { workspace: goCacheWs, storageSize: '5Gi', storageClassName: 'local-path' },
    { workspace: nodeCacheWs, storageSize: '2Gi', storageClassName: 'local-path' },
  ],
});
```

## `outdir` vs `repoRelativePath`

`outdir` is where files are written on disk; `repoRelativePath` is the path baked into the PAC
task annotation. They differ when you synthesize from a subdirectory:

```typescript
outdir: '../.tekton',        // write up one level from the synth script
repoRelativePath: '.tekton', // but reference tasks as `.tekton/tasks/...` from the repo root
```

When `repoRelativePath` is omitted it defaults to `outdir`.

## Options reference

| Option | Default | Description |
|--------|---------|-------------|
| `namespace` | required | Namespace for Task and PipelineRun resources |
| `pipelines` | required | Pipelines to synthesize (only triggered ones are emitted) |
| `name` | — | Prefix applied to all generated resource names |
| `outdir` | `.tekton` | Output directory; tasks go to `<outdir>/tasks/` |
| `repoRelativePath` | `outdir` | Repo-relative path used in task annotations |
| `caches` | — | Persistent cache volumes bound in every PipelineRun |
| `workspaceStorageSize` | `1Gi` | Ephemeral workspace PVC size |
| `workspaceStorageClass` | — | StorageClass for the ephemeral workspace |
| `workspaceAccessModes` | `['ReadWriteOnce']` | Access modes for the ephemeral workspace |
| `serviceAccountName` | `tekton-triggers` | ServiceAccount for PipelineRun pods |
| `maxKeepRuns` | `5` | Completed runs PAC retains per repo |
| `defaultPodSecurityContext` | — | Merged over `DEFAULT_POD_SECURITY_CONTEXT` |
| `defaultStepSecurityContext` | — | Merged over `DEFAULT_STEP_SECURITY_CONTEXT` |
| `defaultLanguage` | — | Default script language for bare-body steps |
| `podTemplateEnv` | — | Env injected into every step of every task (see below) |
| `pacEventContext` | `false` | Inject the PAC event context as `PAC_*` env vars (see below) |
| `targets` | `[new PacTarget({ … })]` | Synthesis targets that emit the project (see below) |

### `podTemplateEnv`

Inject env into every TaskRun pod — useful for the PAC git auth token, whose secret name is
itself a PAC template variable resolved before the run reaches Kubernetes:

```typescript
podTemplateEnv: [{
  name: 'GITHUB_TOKEN',
  valueFrom: { secretKeyRef: { name: '{{ git_auth_secret }}', key: 'git-provider-token' } },
}]
```

### `pacEventContext`

Set it to put the event context into every step as environment variables, substituted by PAC
before the PipelineRun reaches Kubernetes:

| Variable | PAC source |
|----------|-----------|
| `PAC_EVENT_TYPE` | `event_type` |
| `PAC_TARGET_BRANCH` | `target_branch` |
| `PAC_SOURCE_BRANCH` | `source_branch` |
| `PAC_REVISION` | `revision` |
| `PAC_REPO_URL` | `repo_url` |
| `PAC_REPO_OWNER` / `PAC_REPO_NAME` | `repo_owner` / `repo_name` |

Use it where the *event*, not the code, decides what a step does — a scan that runs diff-scoped
on a pull request and full on a push:

```typescript
new TektonicProject({ /* … */ pacEventContext: true });

// in a step
script: sh`
  if [ "$PAC_EVENT_TYPE" = "pull_request" ]; then
    scan --baseline "origin/$PAC_TARGET_BRANCH"
  else
    scan --full
  fi
`
```

Only variables PAC provides for *every* event are injected; an event-specific one (a pull
request number) stays a deliberate `podTemplateEnv` entry, because PAC leaves a variable it
cannot resolve in place as literal text. A `podTemplateEnv` entry of the same name always wins.

### `HOME`

Every pod gets `HOME=/tekton/home` unless the project sets its own. A pod-level `runAsUser`
(tektonic sets one by default) usually has no `/etc/passwd` entry, so `$HOME` resolves to `/`,
which Tekton's creds-init cannot write to — taking git and registry credentials with it.
`/tekton/home` is the writable directory Tekton mounts for exactly that. Override it by putting
`HOME` in `podTemplateEnv`.

## Emitting something other than PAC

PAC is one synthesis target, not the only way out. `TektonicProject` builds a provider-neutral
model — pipeline specs, task manifests, workspace bindings, run defaults — and hands it to each
of its `targets`; the default is a single `PacTarget` configured from the `repository`,
`repoRelativePath`, `maxKeepRuns` and `pacEventContext` options above.

Passing `targets` **replaces** that default, so keep a `PacTarget` in the list if you still want
PAC output:

```typescript
import { PacTarget, TektonTarget, TektonicProject } from '@tektonic-ci/core';

new TektonicProject({
  namespace: 'ci',
  pipelines: [push, pr],
  targets: [
    new PacTarget({ repository: { url: 'https://github.com/acme/app' } }),
    // Plain `kind: Pipeline` + `kind: Task`, for runs started by something other than PAC.
    new TektonTarget({ pipelineDir: 'plain', taskDir: 'plain/tasks' }),
  ],
});
```

Targets share the outdir and own the file names they write, so give them distinct layouts.
Writing your own means implementing `SynthTarget` — see
[architecture.md](architecture.md#synthtarget-srclibcoresynth-targetts).

See [secrets.md](secrets.md) for secret-injection patterns and [caching.md](caching.md) for
cache configuration.
