# API reference

Complete reference for all public classes, interfaces, and constants exported by `@tektonic-ci/core`.

## Core

### `Param`

A Tekton pipeline/task parameter. Implements `toString()` so template literal interpolation produces Tekton expressions.

```typescript
const url = new Param({ name: 'url' });
`git clone ${url}` // → "git clone $(params.url)"
```

#### `ParamOptions`

| Property | Type | Default | Description |
|----------|------|---------|-------------|
| `name` | `string` | *required* | Parameter name in Tekton manifests |
| `description` | `string` | — | Human-readable description |
| `type` | `'string' \| 'array' \| 'object'` | `'string'` | Tekton param type |
| `default` | `string \| string[]` | — | Default value when not supplied at runtime |

#### Methods

| Method | Returns | Description |
|--------|---------|-------------|
| `toString()` | `string` | Returns `$(params.<name>)` |
| `toSpec()` | `Record<string, unknown>` | Serializes to Tekton spec format |

---

### `Workspace`

A Tekton workspace declaration. The `path` and `bound` getters produce interpolation expressions.

```typescript
const ws = new Workspace({ name: 'source' });
ws.path  // → "$(workspaces.source.path)"
ws.bound // → "$(workspaces.source.bound)"
```

#### `WorkspaceOptions`

| Property | Type | Default | Description |
|----------|------|---------|-------------|
| `name` | `string` | *required* | Workspace name in Tekton manifests |
| `description` | `string` | — | Human-readable description |
| `optional` | `boolean` | `false` | Whether the workspace is optional |

#### Properties & methods

| Member | Type | Description |
|--------|------|-------------|
| `path` | `string` (getter) | `$(workspaces.<name>.path)` |
| `bound` | `string` (getter) | `$(workspaces.<name>.bound)` |
| `toSpec()` | `Record<string, unknown>` | Serializes to Tekton spec format |

---

### `Task`

A Tekton Task definition. Declares params, workspaces, steps, and dependencies.

All steps inherit a secure-by-default `stepTemplate` that drops all capabilities and enables seccomp. Override via the `stepTemplate` option.

#### `TaskStepSpec`

| Property | Type | Default | Description |
|----------|------|---------|-------------|
| `name` | `string` | *required* | Step name (unique within task) |
| `image` | `string` | *required* | Container image |
| `imagePullPolicy` | `'Always' \| 'IfNotPresent' \| 'Never'` | kubelet default | Per-step pull policy. Overrides the task's `stepTemplate` and the project's `defaultImagePullPolicy`. Set `'Always'` for images referenced by mutable tag — the kubelet defaults to `IfNotPresent` for every tag but `:latest`. |
| `command` | `string[]` | — | Entrypoint override |
| `args` | `string[]` | — | Arguments to entrypoint |
| `script` | `string` | — | Inline script |
| `workingDir` | `string` | — | Working directory |
| `env` | `{ name: string; value?: string; valueFrom?: { secretKeyRef: { name: string; key: string } } }[]` | — | Environment variables (supports literal values and Secret references) |
| `onError` | `'continue' \| 'stopAndFail'` | `'stopAndFail'` | Whether subsequent steps run when this step fails. Use `'continue'` to let a reporter step always execute. |
| `computeResources` | `{ requests?: { cpu?: string; memory?: string }; limits?: { cpu?: string; memory?: string } }` | — | Per-step CPU/memory override. Overrides the `stepTemplate` defaults. |

#### `TaskOptions`

| Property | Type | Default | Description |
|----------|------|---------|-------------|
| `name` | `string` | *required* | Task name in manifests |
| `params` | `Param[]` | `[]` | Parameters accepted by this task. Reporter and action params are auto-merged — see `statusReporter` and `Action`. |
| `workspaces` | `Workspace[]` | `[]` | Workspaces required by this task |
| `steps` | `(TaskStepSpec \| Action)[]` | *required* | Ordered list of steps. An `Action` expands to one or more steps in this pod and merges its params, workspaces, caches, volumes and results upward. |
| `needs` | `Task[]` | `[]` | Dependency graph edges |
| `stepTemplate` | `Record<string, unknown>` | — | Override/extend step template |
| `statusContext` | `string` | task `name` | Context string reported to the external status system (e.g. `"ci/test"`). Requires `statusReporter`. |
| `statusReporter` | `StatusReporter` | — | When set, automatically appends a final status-reporting step and merges the reporter's `requiredParams` into this task's params. |
| `catalog` | `CatalogMetadata` | — | Marks this task publishable to a Tekton catalog and carries the entry's metadata. Read only by `HubTarget`; nothing about how the task runs changes. See [catalog.md](catalog.md). |

#### Methods

| Method | Returns | Description |
|--------|---------|-------------|
| `synth(scope, namespace, namePrefix?)` | `void` | Synthesizes the Task resource into a cdk8s scope |

---

### `defineAction`

Defines a reusable, versioned unit of work that renders to steps **inside** a composing task's
pod — the action half of the job/action split (a `Task` is the unit of scheduling, an action the
unit of reuse within one). Returns a factory `(inputs, opts?) => Action`.

See [job-libraries.md](job-libraries.md#the-action-layer) for the full guide.

#### `ActionDefinition<In, OutputNames>`

| Property | Type | Default | Description |
|----------|------|---------|-------------|
| `name` | `string` | *required* | Stable identifier; also the default instance name |
| `version` | `string` | — | Version of the action's contract, for pinning |
| `description` | `string` | — | Human-readable description |
| `image` | `string` | — | Default image for this action's steps |
| `outputs` | `Record<OutputNames, string>` | `{}` | Files this action produces, as `logicalName: fileName`. Each becomes an `ActionOutput` at `/tektonic/actions/<instance>-<fileName>`. |
| `params` | `Param[] \| (inputs) => Param[]` | `[]` | Params merged upward into the composing task |
| `workspaces` | `Workspace[] \| (inputs) => Workspace[]` | `[]` | Workspaces merged upward |
| `caches` | `TaskCacheSpec[] \| (inputs) => TaskCacheSpec[]` | `[]` | Caches merged upward |
| `volumes` | `TaskVolumeSpec[] \| (inputs) => TaskVolumeSpec[]` | `[]` | Volumes merged upward |
| `results` | `Result[] \| (inputs) => Result[]` | `[]` | Results merged upward |
| `steps` | `(ctx: ActionCtx) => ActionStepSpec[]` | *required* | Renders the action to steps; `ctx` carries `name`, `inputs`, `outputs`, `image`, `outputDir`. Emitted step names are `<instance>-<step>`, or just the instance name when the step is named after it. |

#### `ActionOptions`

| Property | Type | Default | Description |
|----------|------|---------|-------------|
| `name` | `string` | definition `name` | Instance name within the composing task; prefixes its step names |
| `image` | `string` | definition `image` | Image override for this instance's steps |

#### `Action`

| Property | Type | Description |
|----------|------|-------------|
| `name` / `actionName` / `version` | `string` | Instance name, definition name, definition version |
| `outputs` | `ActionOutputs` | Typed path handles for the declared outputs |
| `steps` | `TaskStepSpec[]` | Steps this action contributes, name-prefixed and image-resolved |
| `params` / `workspaces` / `caches` / `volumes` / `results` | arrays | What it contributes to the composing task |

#### `ActionOutput`

A typed handle to a file an action produces inside the pod. `toString()` returns the in-pod
path, so a downstream step interpolates it directly.

| Method | Returns | Description |
|--------|---------|-------------|
| `toResult(result, opts?)` | `Action` | A step copying this output into a Tekton `Result`, failing if it exceeds the 4KB cap. The result is contributed to the task. |
| `toWorkspace(workspace, dest?, opts?)` | `Action` | A step copying this output into a workspace file (`dest` defaults to the output's file name). The workspace is contributed to the task. |

Both take `{ name?, image? }`: the step name (default `promote-<output>`) and the image the copy
runs in (default: the producing action's image).

---

### `Pipeline`

Composes tasks into a Tekton Pipeline. Automatically discovers transitive dependencies, infers params/workspaces, validates the graph, and topologically sorts tasks.

For pipelines that clone a git repository, prefer [`GitPipeline`](#gitpipeline).

#### `PipelineOptions`

| Property | Type | Default | Description |
|----------|------|---------|-------------|
| `name` | `string` | auto-generated | Pipeline name. Derived from trigger type when omitted |
| `triggers` | `TRIGGER_EVENTS[]` | `[]` | Events that start this pipeline |
| `tasks` | `Task[]` | *required* | Top-level tasks (dependencies auto-discovered) |
| `finallyTasks` | `Task[]` | `[]` | Tasks that run unconditionally after all regular tasks complete or fail |
| `params` | `Param[]` | `[]` | Additional pipeline-level params |

#### Properties

| Property | Type | Description |
|----------|------|-------------|
| `name` | `string` | Resolved pipeline name |
| `triggers` | `TRIGGER_EVENTS[]` | Associated trigger events |
| `tasks` | `Task[]` | Top-level tasks as provided |
| `allTasks` | `Task[]` | All tasks including transitive dependencies |

#### Methods

| Method | Returns | Description |
|--------|---------|-------------|
| `inferParams()` | `Record<string, unknown>[]` | De-duplicated union of all task params plus extra params |
| `inferWorkspaces()` | `Record<string, unknown>[]` | De-duplicated union of all task workspaces |

---

### `GitPipeline`

Extends `Pipeline` with automatic git-clone setup. Creates a `git-clone` task and shared workspace, then wires both into every task in the pipeline:

- The workspace is added to every task's `workspaces` (idempotent — safe to share task instances across multiple `GitPipeline`s)
- `workingDir: $(workspaces.<name>.path)` is injected into every task's `stepTemplate` so steps run in the cloned repo root by default — individual steps can still override `workingDir` explicitly
- Tasks with no explicit `needs` get `runAfter: git-clone` injected at spec-generation time, without mutating `task.needs`

```typescript
const workspace = new Workspace({ name: 'workspace' });

const test = new Task({ name: 'test', steps: [...] });
const build = new Task({ name: 'build', needs: [test], steps: [...] });

const pipeline = new GitPipeline({
  workspace,
  triggers: [TRIGGER_EVENTS.PUSH],
  tasks: [test, build],
  // Execution order: git-clone → test → build
});
```

#### `GitPipelineOptions`

Extends all [`PipelineOptions`](#pipelineoptions) with:

| Property | Type | Default | Description |
|----------|------|---------|-------------|
| `workspace` | `Workspace` | `new Workspace({ name: 'workspace' })` | Shared workspace mounted by all tasks |
| `cloneImage` | `string` | the project's `injectedStepImage` | Container image for the git clone step. Must provide `/bin/sh` and `git` |
| `cloneCatalog` | `CatalogMetadata` | — | Catalog metadata for the generated `git-clone` task, publishing it as a catalog entry. See [catalog.md](catalog.md). |

#### Additional properties

| Property | Type | Description |
|----------|------|-------------|
| `workspace` | `Workspace` | The shared workspace |
| `cloneTask` | `Task` | The auto-generated `git-clone` task |

---

### `TektonProject`

Top-level orchestrator. Synthesizes all tasks, pipelines, and trigger infrastructure to YAML.

#### `TektonProjectOptions`

| Property | Type | Default | Description |
|----------|------|---------|-------------|
| `name` | `string` | `''` | Prefix for all resource names |
| `namespace` | `string` | *required* | Kubernetes namespace |
| `pipelines` | `Pipeline[]` | *required* | Pipelines to synthesize |
| `serviceAccountName` | `string` | `'tekton-triggers'` | Trigger SA name |
| `workspaceStorageSize` | `string` | `'1Gi'` | Ephemeral workspace PVC size per PipelineRun |
| `caches` | `CacheSpec[]` | `[]` | Persistent cache volumes to provision and bind in every PipelineRun |
| `webhookSecretRef` | `{ secretName: string; secretKey: string }` | — | Webhook secret |
| `outdir` | `string` | cdk8s default | Output directory |
| `urlParam` | `string` | `'url'` | Param name for repository URL |
| `revisionParam` | `string` | `'revision'` | Param name for git revision |
| `gitRefParam` | `string` | — | Param name for the git ref string (branch or tag ref, e.g. `refs/heads/main`). When set, the trigger infrastructure passes the ref to each PipelineRun. |

#### `CacheSpec`

Declares a persistent cache workspace. `TektonProject` generates a `PersistentVolumeClaim` manifest for the cache and binds it in every PipelineRun.

| Property | Type | Default | Description |
|----------|------|---------|-------------|
| `workspace` | `Workspace` | *required* | Workspace to bind as a persistent volume |
| `storageSize` | `string` | `'1Gi'` | PVC storage capacity |
| `claimName` | `string` | `${name}-${workspace.name}` | PVC resource name; defaults to project name prefix + workspace name |
| `storageClassName` | `string` | — | StorageClass; omitted to use cluster default |

```typescript
const grypeCache = new Workspace({ name: 'grype-cache' });

const scanTask = new Task({
  name: 'scan',
  workspaces: [grypeCache],
  steps: [{
    name: 'scan',
    image: 'ghcr.io/anchore/grype:latest',
    env: [{ name: 'GRYPE_DB_CACHE_DIR', value: grypeCache.path }],
    command: ['/grype', 'sbom:./sbom.json'],
  }],
});

new TektonProject({
  name: 'my-app',
  namespace: 'ci',
  pipelines: [...],
  caches: [{ workspace: grypeCache, storageSize: '2Gi' }],
});
// → generates a PersistentVolumeClaim 'my-app-grype-cache' and binds it in every PipelineRun
```

---

### `TRIGGER_EVENTS`

Enum of GitHub webhook event types.

| Member | Value | Description |
|--------|-------|-------------|
| `PUSH` | `'push'` | Branch pushes (excludes tags when tag pipeline exists) |
| `PULL_REQUEST` | `'pull_request'` | Pull request opened/synchronized |
| `TAG` | `'tag'` | Tag pushes (filtered via CEL on `refs/tags/`) |

---

## Status reporting

### `StatusReporter`

Provider-agnostic interface for reporting pipeline task statuses to an external system.

| Member | Description |
|--------|-------------|
| `createPendingTask(contexts: string[])` | Returns a `Task` that marks all given context strings as "pending" before any other task runs |
| `finalStep(context: string, userStepNames?: string[])` | Returns a `TaskStepSpec` that reports success or failure for the given context, from the worst of `/tekton/home/.exit-code` and Tekton's own `/tekton/steps/step-<name>/exitCode` for each named user step. `Task` supplies the names; omitting them falls back to the contract file alone. |
| `startStep?(context: string)` | Optional. Returns a `TaskStepSpec` that reports the context as running. `Task` prepends it as the first step, ahead of cache restore, and always renders it with `onError: 'continue'`; a reporter without it emits no start step. |
| `requiredParams` | `Param[]` — params this reporter needs (e.g. repo name, revision). Automatically merged into the `params` of any `Task` that uses this reporter. |

### `GitHubStatusReporter`

> Ships in **`@tektonic-ci/reporter-github`**, not the core package.
> `npm install @tektonic-ci/reporter-github`

Reports task statuses to the [GitHub Commit Status API](https://docs.github.com/en/rest/commits/statuses). Zero-config with sensible defaults.

```typescript
const reporter = new GitHubStatusReporter();
// Requires a 'github-token' Secret in the namespace with key 'token'
```

Attach to a task to have it report its status to GitHub:

```typescript
const test = new Task({
  name: 'test',
  statusContext: 'ci/test',   // label shown on the PR; defaults to task name
  statusReporter: reporter,
  steps: [{
    name: 'run',
    image: 'node:22-alpine',
    command: ['sh', '-c'],
    args: ['npm test; EC=$?; echo $EC > /tekton/home/.exit-code; exit $EC'],
    onError: 'continue',
  }],
});
```

#### `GitHubStatusReporterOptions`

All options are optional.

| Property | Type | Default | Description |
|----------|------|---------|-------------|
| `image` | `string` | the project's `injectedStepImage` | Image used for status-reporting steps. Must provide `nushell` — the POSTs use `http post` — so a project using this reporter names an image that has it (see [injected-step images](#injected-step-images)) |
| `tokenSecretName` | `string` | `'github-token'` | Name of the Kubernetes Secret containing the GitHub token at key `token` |
| `repoFullNameParam` | `Param` | `new Param({ name: 'repo-full-name' })` | Param supplying the `owner/repo` value |
| `revisionParam` | `Param` | `new Param({ name: 'revision' })` | Param supplying the commit SHA |

> **Note:** The `repoFullNameParam` and `revisionParam` are automatically injected into any task that uses this reporter — you don't need to add them to the task's `params`.

---

## Triggers

### `GitHubTriggerBase`

Abstract base class for GitHub webhook triggers. Generates a TriggerBinding + TriggerTemplate pair.

#### `GitHubTriggerBaseProps`

| Property | Type | Default | Description |
|----------|------|---------|-------------|
| `namespace` | `string` | *required* | Namespace for trigger resources |
| `pipelineRef` | `string` | *required* | Pipeline name to reference |
| `workspaceStorageSize` | `string` | `'1Gi'` | PVC size |
| `serviceAccountName` | `string` | `'tekton-triggers'` | SA for PipelineRun |
| `namePrefix` | `string` | — | Resource name prefix |
| `urlParam` | `string` | `'url'` | Pipeline param for repo URL |
| `revisionParam` | `string` | `'revision'` | Pipeline param for git revision |

#### `GitHubTriggerConfig`

| Property | Type | Description |
|----------|------|-------------|
| `bindingName` | `string` | TriggerBinding resource name |
| `templateName` | `string` | TriggerTemplate resource name |
| `pipelineRunGenerateName` | `string` | `generateName` prefix for PipelineRuns |
| `gitRevisionValue` | `string` | Expression extracting revision from webhook payload |

#### Properties

| Property | Type | Description |
|--------|------|-------------|
| `bindingRef` | `string` | Fully-qualified TriggerBinding name |
| `templateRef` | `string` | Fully-qualified TriggerTemplate name |

### `GitHubPushTrigger`

Trigger for `push` events. Extracts revision from `body.head_commit.id`.

### `GitHubPullRequestTrigger`

Trigger for `pull_request` events. Extracts revision from `body.pull_request.head.sha`.

### `GitHubTagTrigger`

Trigger for tag push events. Extracts revision from `body.ref`.

---

## Infrastructure

### `TektonInfraChart`

cdk8s Chart that generates shared trigger infrastructure: ServiceAccount, RBAC, triggers, and EventListener.

#### `TektonInfraChartProps`

| Property | Type | Default | Description |
|----------|------|---------|-------------|
| `namespace` | `string` | *required* | Namespace for infrastructure resources |
| `pushPipelineRef` | `string` | `'push-pipeline'` | Pipeline for push events |
| `pullRequestPipelineRef` | `string` | `'pull-request-pipeline'` | Pipeline for PR events |
| `tagPipelineRef` | `string` | — | Pipeline for tag events (enables tag trigger) |
| `namePrefix` | `string` | — | Resource name prefix |
| `webhookSecretRef` | `{ secretName: string; secretKey: string }` | — | Webhook secret |
| `urlParam` | `string` | `'url'` | Param name for repo URL |
| `revisionParam` | `string` | `'revision'` | Param name for git revision |

---

## Injected-step images

Tektonic generates the script for every step it injects — git clone, cache restore/save,
status reporting, change detection — and ships no image of its own: it only expects the image
to *provide* the interpreters and CLIs those scripts invoke (`sh`, `git`, `nushell`, `tar`,
`zstd`, `gcloud`).

Each injected step resolves its image in one order:

1. The step's own — `TaskCacheSpec.image`, `GitPipelineOptions.cloneImage`, a reporter's or
   cache backend's `image`.
2. The component's own default, when it has one.
3. `TektonicProjectOptions.injectedStepImage`.
4. `DEFAULT_INJECTED_STEP_IMAGE` — a neutral, public image providing `sh` and `git` only.

Because the fallback is deliberately minimal, a feature needing more fails **at synth time**
with a message naming the capability, rather than at pod-run time with `command not found`:

```ts
new TektonicProject({
  // …
  injectedStepImage: DEFAULT_BASE_IMAGE,                    // an image with all of them
  // or trusted-with-a-declaration, so the check is real:
  injectedStepImage: { image: 'ghcr.io/acme/ci-base:1.4.0', provides: ['sh', 'git', 'nushell'] },
});
```

A bare string is taken at its word — synthesis is offline and never probes a registry. The
object form declares what the image actually has, and is checked against what each step asked
for. Third-party backends and reporters declare their own needs with
`injectedImageRef('nushell', 'zstd')` instead of hardcoding an image.

| Export | Type | Description |
|--------|------|-------------|
| `injectedImageRef(...caps)` | `(...ImageCapability[]) => string` | The image an injected step uses when the caller named none, declaring what it needs |
| `DEFAULT_INJECTED_STEP_IMAGE` | `InjectedStepImageSpec` | The neutral fallback (`sh`, `git`) |
| `DEFAULT_BASE_IMAGE` | `string` | An image providing every capability; pass it to `injectedStepImage` |
| `DEFAULT_GCS_CACHE_IMAGE` | `string` | *(in `@tektonic-ci/cache-gcs`)* an image providing the GCS set; pass it to `gcs({ bucket, image })` |

---

## Constants

| Constant | Value | Description |
|----------|-------|-------------|
| `TEKTON_API_V1` | `'tekton.dev/v1'` | Tekton Pipelines API version |
| `TRIGGERS_API` | `'triggers.tekton.dev/v1beta1'` | Tekton Triggers API version |
| `PIPELINE_RUN_API` | `'tekton.dev/v1'` | PipelineRun API version |
| `DEFAULT_SERVICE_ACCOUNT` | `'tekton-triggers'` | Default trigger SA name |
| `DEFAULT_WORKSPACE_STORAGE` | `'1Gi'` | Default PVC size |
| `GITHUB_REPO_URL` | `'https://github.com/$(body.repository.full_name)'` | Repo URL expression |
| `DEFAULT_STEP_SECURITY_CONTEXT` | `{ allowPrivilegeEscalation: false, ... }` | Default step security context |
| `RESTRICTED_STEP_SECURITY_CONTEXT` | `{ ..., runAsNonRoot: true }` | Stricter security context with `runAsNonRoot` |
| `DEFAULT_STEP_RESOURCES` | `{ requests: { cpu: '100m', memory: '128Mi' }, limits: { cpu: '1', memory: '512Mi' } }` | Default step resource requests and limits |
