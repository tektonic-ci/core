import { Construct } from "constructs";
import { ApiObject } from "cdk8s";
import {
    TEKTON_API_V1,
    DEFAULT_STEP_SECURITY_CONTEXT,
    DEFAULT_STEP_RESOURCES,
} from "../constants";
import { Param } from "./param";
import { Workspace } from "./workspace";
import { Result } from "./result";
import { Condition, normalizeWhen } from "./condition";
import type { WhenClause } from "./condition";
import { PvcBackend } from "../cache/pvc-backend";
import type { StatusReporter } from "./status-reporter";
import type { CacheBackend, BackendCtx } from "./cache-backend";
import { renderScript, EXIT_CODE_PATH } from "../script";
import type { ScriptInput, LanguageName, ScriptCtx } from "../script";
import { Action, ACTION_OUTPUT_DIR, ACTION_VOLUME_NAME } from "./action";
import {
    injectedImageRef,
    normalizeInjectedStepImage,
    resolveInjectedImage,
} from "./injected-image";
import type { InjectedStepImage } from "./injected-image";
import { ActionArtifactSource, TaskArtifact, WorkspaceArtifactStore, artifactStoreCtx } from "./artifact";
import { artifactProvenanceStep } from "./artifact-provenance";
import type { CatalogMetadata } from "./catalog";
import type { ArtifactSource, ArtifactStore } from "./artifact";

/**
 * Kubernetes image pull policy.
 *
 * The kubelet defaults to `IfNotPresent` for every tag except `:latest`, so a mutable
 * tag (a moving `:stable`, or a version tag republished by a rebuild) is served from the
 * node's image cache indefinitely once pulled. Set `Always` on steps whose images are
 * referenced by tag rather than digest.
 */
export type ImagePullPolicy = "Always" | "IfNotPresent" | "Never";

/**
 * Project-level defaults handed to {@link TaskDef.synth}. {@link TektonicProject} fills
 * these from its own options; a task synthesized directly (in a test, say) may pass any
 * subset and gets the library defaults for the rest.
 */
export interface TaskSynthOptions {
    /** Name prefix applied to the emitted resource name, as `TektonicProject.name` does. */
    namePrefix?: string;
    /**
     * Additional container-level security context fields merged on top of
     * `DEFAULT_STEP_SECURITY_CONTEXT`, from the project's `defaultStepSecurityContext`. The
     * task's own `stepTemplate.securityContext` (if any) takes precedence over this.
     */
    stepSecurityContext?: Record<string, unknown>;
    /**
     * Project-level default scripting language, used for bare-body steps when the task does
     * not set its own `defaultLanguage`.
     */
    defaultLanguage?: LanguageName;
    /**
     * Project-level pull policy written into this task's `stepTemplate`, so it also covers
     * the injected cache and reporter steps. The task's own `stepTemplate.imagePullPolicy`
     * (if any) takes precedence; a step's own `imagePullPolicy` takes precedence over both.
     * Tekton applies `stepTemplate` to steps only — sidecars must set their own.
     */
    defaultImagePullPolicy?: ImagePullPolicy;
    /**
     * Project-level image for the steps tektonic injects (clone, cache restore/save, status
     * reporting, change detection). Any of those steps given no image of its own resolves to
     * this one at synth time, and synthesis fails when the image does not declare a
     * capability the step needs. Defaults to {@link DEFAULT_INJECTED_STEP_IMAGE}.
     */
    injectedStepImage?: InjectedStepImage;
    /**
     * Project-level default for TEP-0147 artifact provenance, from the project's
     * `artifactProvenance`. A task's own setting wins; `false` unless something turns it on.
     */
    artifactProvenance?: boolean;
}

/** Specification for a single step within a Tekton Task. */
export interface TaskStepSpec {
    /** Step name (must be unique within the task). */
    name: string;
    /** Container image to run for this step. */
    image: string;
    /**
     * Pull policy for this step's image. Overrides the task's `stepTemplate` and the
     * project's `defaultImagePullPolicy`. Omitted from the manifest when unset, leaving
     * the kubelet default in place.
     */
    imagePullPolicy?: ImagePullPolicy;
    /** Entrypoint command override. */
    command?: string[];
    /** Arguments passed to the entrypoint. */
    args?: string[];
    /**
     * Script executed by the step. Accepts a raw string (shebang-based,
     * back-compatible), a language-tagged body (`bash`/`nu`/`py`), or a
     * `{ language, body }` object. A raw string without a shebang is rendered
     * with the task/project `defaultLanguage` when one is set.
     */
    script?: ScriptInput;
    /** Working directory for the step. */
    workingDir?: string;
    /** Environment variables injected into the step container. */
    env?: {
        name: string;
        value?: string;
        valueFrom?: { secretKeyRef: { name: string; key: string; optional?: boolean } };
    }[];
    /** Controls behaviour when this step fails. `continue` lets subsequent steps run. */
    onError?: "continue" | "stopAndFail";
    /** CPU/memory requests and limits for this step (overrides stepTemplate computeResources). */
    computeResources?: {
        requests?: { cpu?: string; memory?: string; "ephemeral-storage"?: string };
        limits?: { cpu?: string; memory?: string; "ephemeral-storage"?: string };
    };
    /** Per-step container securityContext override. Applied on top of the task stepTemplate. */
    securityContext?: Record<string, unknown>;
    /** Volume mounts for this step. Each entry must reference a volume declared in the task's `volumes` array or a workspace-backed volume. */
    volumeMounts?: {
        name: string;
        mountPath: string;
        readOnly?: boolean;
        subPath?: string;
    }[];
}

/**
 * Declares a cache entry for a task. The library injects restore and save
 * steps automatically around the user's steps, following the same hash-based
 * hit/miss strategy as GitLab CI's `cache:` keyword.
 */
export interface TaskCacheSpec {
    /**
     * Human-readable name for this cache, used in step names and log output.
     * For example, `"npm"` produces steps named `restore-npm-cache` and `save-npm-cache`.
     * Required.
     */
    name: string;
    /**
     * Files (relative to workingDir) whose combined content determines the cache key.
     * An empty array produces a fixed hash, meaning the cache always hits after the
     * first run — useful for tool-managed caches like vulnerability databases.
     */
    key: string[];
    /** Paths (relative to workingDir) to restore on hit and save on miss. */
    paths: string[];
    /**
     * Workspace (PVC) where cache entries are stored. Auto-added to task workspaces if absent.
     * Required for PVC backends. Ignored by a backend whose `needsPvcWorkspace` is false.
     */
    workspace?: Workspace;
    /**
     * Image for the injected restore/save steps. When omitted, the backend's own default
     * is used, falling back to the project's `injectedStepImage` — which must declare the
     * capabilities the backend asked for (`nushell`/`tar`/`zstd` for a compressed cache,
     * plus `gcloud` for the GCS backend), or synthesis fails naming them.
     */
    image?: string;
    /**
     * Compress the cache into a single zstd archive (`.tar.zst`) instead of copying
     * path trees directly. Reduces NFS I/O from thousands of file operations to one
     * read/write. Requires the step image to have `tar` with `--zstd` support and nushell.
     */
    compress?: boolean;
    /**
     * Working directory for the injected restore and save steps. Paths in `key` and
     * `paths` are resolved relative to this directory. Typically set to the Tekton
     * workspace expression, e.g. `$(workspaces.workspace.path)`.
     */
    workingDir?: string;
    /**
     * zstd compression level (1–19). Lower levels are faster and use less memory.
     * Level 1 uses ~1 MB working memory and still achieves ~2.5× compression.
     * Only applies when `compress` is `true`. Defaults to `1`.
     */
    compressionLevel?: number;
    /**
     * Explicit `computeResources` for the injected cache restore and save steps,
     * overriding the stepTemplate default. Useful for constraining memory when the
     * build step consumes most of the node's RAM.
     */
    computeResources?: {
        requests?: { cpu?: string; memory?: string; "ephemeral-storage"?: string };
        limits?: { cpu?: string; memory?: string; "ephemeral-storage"?: string };
    };
    /**
     * Maximum number of cache archive entries to keep per workspace. During save,
     * entries older than the newest `maxEntries` are deleted. Defaults to `3`.
     * Set to `0` to disable eviction.
     */
    maxEntries?: number;
    /**
     * Strategy for running the cache save step.
     *
     * - `"step"` (default) — save runs as a step within the build pod. Fastest,
     *   but shares node memory with the build steps; can cause OOM on memory-
     *   intensive builds (e.g. large Go projects on constrained nodes).
     *
     * - `"finally"` — save runs as a separate Tekton *finally* task in its own
     *   pod. The build pod is fully terminated (and its memory reclaimed) before
     *   compression starts. Adds ~10–15 s scheduling overhead.
     */
    saveStrategy?: "step" | "finally";
    /**
     * Always overwrite the cache archive on save, even if one already exists
     * for the current hash. Use this for tool-managed caches where the tool
     * updates its data in-place (e.g. grype vulnerability database).
     * Defaults to `false`.
     */
    forceSave?: boolean;
    /**
     * Cache storage backend. Defaults to PVC-based caching (using the
     * `workspace` property) when omitted.
     *
     * Set an out-of-tree backend to store archives elsewhere — `gcs({ bucket, prefix? })`
     * from `@tektonic-ci/cache-gcs`, or your own. See docs/cache-backends.md.
     */
    backend?: CacheBackend;
    /**
     * Use multi-threaded zstd compression (`-T0`, auto-detect threads) instead
     * of single-threaded (`-T1`). Faster on nodes with spare CPU but uses more
     * memory. Only applies when `compress` is `true`.
     *
     * Defaults to `false` for the built-in PVC backend (constrained environments);
     * a remote backend may default it to `true` (the GCS one does).
     */
    multiThreadCompression?: boolean;
    /**
     * Skip cache restore if any of the cache paths already exist in the working
     * directory. Useful when a prior task in the same pipeline run has already
     * populated the paths on the shared workspace PVC — re-extracting the archive
     * would discard that work.
     *
     * The hash is still computed and saved so the save step can update the archive.
     * Defaults to `false`.
     */
    skipRestoreIfPathsExist?: boolean;
}

/**
 * Specification for a sidecar container that runs alongside a task's steps.
 *
 * Sidecars start before the steps begin and are terminated after all steps complete.
 * Common uses: database containers for integration tests, docker-in-docker, local
 * service stubs.
 *
 * Unlike steps, sidecars do not support `onError` and are not sequenced by Tekton.
 */
export interface TaskSidecarSpec {
    /** Sidecar name (must be unique within the task). */
    name: string;
    /** Container image to run. */
    image: string;
    /**
     * Pull policy for this sidecar's image. Tekton applies `stepTemplate` to steps only, so
     * a project-level `defaultImagePullPolicy` cannot reach sidecars through it — tektonic
     * stamps it onto each sidecar directly instead. Set this to override that for one
     * sidecar.
     */
    imagePullPolicy?: ImagePullPolicy;
    /** Entrypoint command override. */
    command?: string[];
    /** Arguments passed to the entrypoint. */
    args?: string[];
    /**
     * Inline script executed by the sidecar (requires an image with a shell). Accepts the
     * same {@link ScriptInput} as a step — a language tag, an object form, or
     * `scriptFromFile` — so sidecar bodies get the shebang, dedenting, `log` preamble and
     * linting that step bodies get. The exit-code contract is never applied: a sidecar's
     * lifetime is the task's, and it reports no status.
     */
    script?: ScriptInput;
    /** Working directory for the sidecar container. */
    workingDir?: string;
    /** Environment variables injected into the sidecar container. */
    env?: {
        name: string;
        value?: string;
        valueFrom?: { secretKeyRef: { name: string; key: string; optional?: boolean } };
    }[];
    /** CPU/memory requests and limits for this sidecar. */
    computeResources?: {
        requests?: { cpu?: string; memory?: string; "ephemeral-storage"?: string };
        limits?: { cpu?: string; memory?: string; "ephemeral-storage"?: string };
    };
    /** Per-container security context override. */
    securityContext?: Record<string, unknown>;
    /**
     * Volume mounts for this sidecar. Each entry must reference a volume declared in the
     * task's `volumes` array. Sharing an `emptyDir` with a step is the usual way to hand
     * files to or from a sidecar; a volume also keeps a database sidecar's data dir off the
     * container's writable layer.
     */
    volumeMounts?: {
        name: string;
        mountPath: string;
        readOnly?: boolean;
        subPath?: string;
    }[];
    /**
     * Probe used by Tekton to determine when the sidecar is ready to serve traffic.
     * Follows the Kubernetes `v1.Probe` schema.
     */
    readinessProbe?: Record<string, unknown>;
}

/**
 * A Kubernetes volume available for mounting in task steps or sidecars.
 *
 * Follows the Kubernetes `v1.Volume` schema — `name` is required; all other
 * fields are passed through as-is. Common volume types: `emptyDir`, `configMap`,
 * `secret`, `persistentVolumeClaim`.
 *
 * @example
 * ```ts
 * // Shared tmpfs between a step and a sidecar
 * { name: 'shared', emptyDir: { medium: 'Memory' } }
 * ```
 */
export interface TaskVolumeSpec {
    name: string;
    [key: string]: unknown;
}

/** Keeps the first occurrence of each name, so what a task states itself wins over what an action contributes. */
function mergeByName<T extends { name: string }>(items: T[]): T[] {
    const seen = new Map<string, T>();
    for (const item of items) {
        if (!seen.has(item.name)) seen.set(item.name, item);
    }
    return [...seen.values()];
}

/** Minimum contract shared by all task-like nodes in a pipeline. */
export interface TaskLike {
    readonly name: string;
    readonly synthesizable: boolean;
    readonly needs: TaskLike[];
    readonly params: Param[];
    readonly workspaces: Workspace[];
    _toPipelineTaskSpec(runAfterNames: string[], namePrefix?: string): Record<string, unknown>;
}

/**
 * Anything accepted in a task's `steps`: a hand-written step, or an {@link Action} that
 * expands to one or more steps inside the same pod.
 */
export type TaskStepInput = TaskStepSpec | Action<string>;

/**
 * Options for constructing a {@link TaskDef}.
 *
 * `AN` is the set of artifact names the task declares in `produces`; it is inferred, and
 * surfaces as the keys of {@link TaskDef.artifacts}.
 */
export interface TaskOptions<AN extends string = never> {
    /** Task name used in Tekton manifests and pipeline task references. */
    name: string;
    /** Parameters accepted by this task. */
    params?: Param[];
    /** Workspaces required by this task. */
    workspaces?: Workspace[];
    /**
     * Ordered list of steps the task executes. An entry may be an {@link Action} — a reusable,
     * typed unit of work that expands to one or more steps in this pod and merges its params,
     * workspaces, caches, volumes and results upward into this task.
     */
    steps: TaskStepInput[];
    /** Tasks that must complete before this task runs (dependency graph edges). */
    needs?: TaskLike[];
    /** Override or extend the default step template (merged with security context defaults). */
    stepTemplate?: Record<string, unknown>;
    /**
     * Status context string reported to the external system (e.g. `"ci/test"`).
     * When set together with `statusReporter`, the reporter's `finalStep` is
     * automatically appended to this task's steps at synthesis time.
     */
    statusContext?: string;
    /** Reporter used to generate the final-status step for this task. */
    statusReporter?: StatusReporter;
    /**
     * Cache declarations for this task. For each entry the library injects a
     * restore step before the user's steps and a save step after them.
     * The cache workspace is auto-registered if not already in `workspaces`.
     */
    caches?: TaskCacheSpec[];
    /** Results this task produces. Each result is bound to the task name at construction time. */
    results?: Result[];
    /**
     * Sidecar containers that run alongside this task's steps for the duration of the task pod.
     * Start before steps begin; terminated after all steps complete.
     */
    sidecars?: TaskSidecarSpec[];
    /**
     * Additional Kubernetes volumes made available for mounting in steps and sidecars.
     * Volumes declared here supplement (not replace) workspace-backed volumes.
     * Follows the Kubernetes `v1.Volume` schema — `name` is required.
     */
    volumes?: TaskVolumeSpec[];
    /**
     * Default scripting language for this task's steps whose `script` is a bare
     * body (a `{ language, body }` object or a raw string without a shebang).
     * Language-tagged bodies (`bash`/`nu`/`py`) carry their own language and
     * ignore this. Falls back to the project-level default when unset.
     */
    defaultLanguage?: LanguageName;
    /**
     * Annotations to set on the generated Task's metadata. A generic escape hatch
     * for ecosystem integrations — e.g. `chains.tekton.dev/*` for Tekton Chains.
     */
    annotations?: Record<string, string>;
    /**
     * Conditional guard controlling whether this task runs — a typed {@link Condition}
     * (e.g. `onBranch('main')`, `equals(result, 'go').and(...)`) or raw `when` clauses.
     * Emitted as the pipeline task's `when`. Exact-match conditions need no cluster
     * feature flag; pattern/OR conditions compile to CEL and require
     * `enable-cel-in-whenexpression`.
     */
    when?: Condition | WhenClause[];
    /**
     * Number of times to retry this task's TaskRun on failure
     * (`v1.PipelineTask.retries`). Useful for flaky, network-dependent tasks.
     */
    retries?: number;
    /**
     * Maximum duration before this task's TaskRun times out, as a Go duration string
     * (e.g. `"10m"`, `"1h30m"`). Corresponds to `v1.PipelineTask.timeout`.
     */
    timeout?: string;
    /**
     * Fan this task out at runtime into one TaskRun per element of an array
     * {@link Result}, via a Tekton `matrix`. `over` is the array result driving the
     * fan-out; `as` is the string {@link Param} (declared in `params`) each element
     * fills. The producing task is auto-added to `needs` so ordering is correct; pass
     * `from` when the result's producer can't be inferred from `over.owner`.
     */
    fanOut?: { over: Result; as: Param; from?: TaskLike };
    /**
     * Files this task publishes for other tasks in the pipeline to read, as
     * `logicalName: source`. Each becomes a typed {@link TaskArtifact} on
     * {@link TaskDef.artifacts}, which a consumer names in its own `consumes`.
     *
     * A source is either an {@link ActionOutput} promoted with `.toArtifact()`, or a path a
     * hand-written step wrote — absolute, or relative to the step's working directory. A
     * publish step is injected after this task's steps; nothing else moves.
     *
     * ```ts
     * const build = new Task({
     *   name: 'build',
     *   workspaces: [ws],
     *   steps: [compile],
     *   produces: { dist: 'target/app.tar', report: compile.outputs.junit.toArtifact() },
     * });
     * ```
     *
     * Declaring an artifact nothing consumes is legitimate — publishing for a human to
     * collect — and warns rather than failing.
     */
    produces?: Record<AN, ArtifactSource>;
    /**
     * Artifacts this task reads, named through their producing task —
     * `consumes: [build.artifacts.dist]`.
     *
     * A fetch step is injected before this task's steps, and synthesis fails when the
     * producing task is absent from the pipeline or is not a transitive `needs` of this one.
     * That ordering check is the point: it turns a runtime file-not-found into a synth-time
     * error naming both tasks. Consuming does not create the edge — declare it in `needs`.
     */
    consumes?: TaskArtifact[];
    /**
     * Workspace `produces` publishes onto. Defaults to this task's only workspace; required
     * when it has more than one, since the choice is otherwise arbitrary. Ignored by a store
     * that keeps artifacts elsewhere.
     */
    artifactWorkspace?: Workspace;
    /**
     * Where this task's artifacts are stored. Defaults to {@link WorkspaceArtifactStore} —
     * a per-producer subtree of the workspace the pipeline already binds. Set an out-of-tree
     * store to keep them somewhere else; the declaration, the ordering check and the handle
     * types are unaffected. See docs/adr/0001-artifacts-and-dependencies.md.
     */
    artifactStore?: ArtifactStore;
    /**
     * Emit TEP-0147 artifact provenance for this task's declared artifacts — a record of what
     * it read and wrote, as `{uri, digest}` pairs in the TaskRun status, for Tekton Chains.
     *
     * Overrides the project's `artifactProvenance`, and off unless one of them turns it on:
     * the upstream feature is alpha and needs the cluster's `enable-artifacts` feature flag,
     * so a cluster without it would gain a step whose output nothing reads.
     *
     * This adds no transport. Which artifact is a *subject* of the attestation rather than a
     * byproduct is {@link ArtifactSpec.buildOutput}, per artifact.
     */
    artifactProvenance?: boolean;
    /**
     * Marks this task publishable to a Tekton catalog, and carries the metadata an entry
     * needs beyond the manifest itself — version, description, categories, platforms.
     *
     * Only read by a target that publishes catalog entries: `HubTarget` emits exactly the
     * tasks carrying it and ignores the rest. Nothing about how the task runs changes.
     */
    catalog?: CatalogMetadata;
}

/**
 * A Tekton Task definition.
 *
 * Tasks are the unit of work in a Tekton pipeline. Each task declares its
 * params, workspaces, and steps. The {@link needs} array defines the dependency
 * graph — pipelines automatically discover transitive dependencies and set
 * `runAfter` ordering.
 *
 * All steps inherit a secure-by-default `stepTemplate` that drops all
 * capabilities and enables seccomp. Override via the `stepTemplate` option.
 */
export class TaskDef<AN extends string = never> implements TaskLike {
    readonly synthesizable = true as const;
    readonly name: string;
    readonly params: Param[];
    readonly workspaces: Workspace[];
    /** Steps this task executes, with every composed {@link Action} already expanded. */
    readonly steps: TaskStepSpec[];
    /** Actions composed into this task, in the order they appear in `steps`. */
    readonly actions: Action<string>[];
    /** Step names contributed by an action, mapped to the contributing instance name. */
    private readonly _actionStepOwners = new Map<string, string>();
    /** Tasks that must complete before this task runs. */
    readonly needs: TaskLike[];
    readonly stepTemplate?: Record<string, unknown>;
    /** Status context reported to the external system. */
    readonly statusContext?: string;
    /** Reporter that generates the final-status step. */
    readonly statusReporter?: StatusReporter;
    /** Cache declarations — restore/save steps are injected at synthesis time. */
    readonly caches: TaskCacheSpec[];
    /**
     * Names of caches whose paths land in a workspace this task shares with others, as
     * detected by {@link Pipeline}. Restore for these defaults to `skipRestoreIfPathsExist`
     * so a warm tree another task populated is not swapped out from under it.
     */
    private readonly _sharedWorkspaceCaches = new Set<string>();
    /** Results this task produces, bound to this task's name at construction time. */
    readonly results: Result[];
    /** Sidecar containers that run alongside steps for the task pod's lifetime. */
    readonly sidecars: TaskSidecarSpec[];
    /** Additional Kubernetes volumes available for mounting in steps and sidecars. */
    readonly volumes: TaskVolumeSpec[];
    /** Default scripting language for bare-body steps; falls back to the project default. */
    readonly defaultLanguage?: LanguageName;
    /** Annotations set on the generated Task metadata. */
    readonly annotations?: Record<string, string>;
    /** Conditional guard emitted as the pipeline task's `when`. */
    readonly when?: Condition | WhenClause[];
    /** Retry count on failure, emitted as the pipeline task's `retries`. */
    readonly retries?: number;
    /** TaskRun timeout (Go duration), emitted as the pipeline task's `timeout`. */
    readonly timeout?: string;
    /** Runtime fan-out over an array result, emitted as the pipeline task's `matrix`. */
    readonly fanOut?: { over: Result; as: Param; from?: TaskLike };
    /** Catalog metadata, when this task is publishable. Read by catalog-publishing targets. */
    readonly catalog?: CatalogMetadata;
    /**
     * Whether this task emits TEP-0147 artifact provenance, overriding the project's setting.
     * `undefined` defers to the project, which defaults to off.
     */
    readonly artifactProvenance?: boolean;
    /**
     * Typed handles for the artifacts this task publishes, keyed by the names `produces`
     * declared — `build.artifacts.dist`. A consumer names one in its own `consumes`.
     */
    readonly artifacts: { readonly [K in AN]: TaskArtifact };
    /** The same artifacts as a list, for callers that do not know the names. */
    readonly produces: TaskArtifact[];
    /** Artifacts this task reads, each carrying the task that publishes it. */
    readonly consumes: TaskArtifact[];

    constructor(opts: TaskOptions<AN>) {
        this.name = opts.name;
        // Actions are pod-internal: they expand to ordinary steps here, then contribute what
        // they need upward — the same direction StatusReporter.requiredParams flow, and with
        // the same precedence (what the task states itself wins).
        this.actions = opts.steps.filter((s): s is Action<string> => s instanceof Action);
        const actionNames = new Set<string>();
        for (const a of this.actions) {
            if (actionNames.has(a.name)) {
                throw new Error(
                    `Task '${this.name}': two actions are composed as '${a.name}' — pass ` +
                        `{ name } to one of them, since step names derive from it`,
                );
            }
            actionNames.add(a.name);
        }
        this.steps = opts.steps.flatMap((s) => (s instanceof Action ? s.steps : [s]));
        for (const a of this.actions) {
            for (const s of a.steps) this._actionStepOwners.set(s.name, a.name);
        }
        const stepNames = new Set<string>();
        for (const s of this.steps) {
            if (stepNames.has(s.name)) {
                throw new Error(
                    `Task '${this.name}': duplicate step name '${s.name}' — Tekton requires step ` +
                        `names to be unique within a task`,
                );
            }
            stepNames.add(s.name);
        }
        // Auto-merge action and statusReporter.requiredParams into task params (user params take precedence)
        const base = opts.params ?? [];
        const actionParams = this.actions.flatMap((a) => a.params);
        const reporterParams = opts.statusReporter?.requiredParams ?? [];
        const seen = new Map<string, Param>();
        for (const p of [...base, ...actionParams, ...reporterParams]) {
            if (!seen.has(p.name)) seen.set(p.name, p);
        }
        this.params = [...seen.values()];
        this.workspaces = mergeByName([
            ...(opts.workspaces ?? []),
            ...this.actions.flatMap((a) => a.workspaces),
        ]);
        // Copy so fan-out edge injection never mutates a caller-supplied array.
        this.needs = [...(opts.needs ?? [])];
        this.stepTemplate = opts.stepTemplate;
        this.statusContext = opts.statusContext ?? opts.name;
        this.statusReporter = opts.statusReporter;
        // In a reporting task the framework owns the exit-code contract: every user step runs
        // with onError:'continue' so the appended reporter step reads the captured code. A step
        // that sets 'stopAndFail' takes the pod down before the reporter runs, leaving the
        // context on "pending" until the reconciler settles it — same reason a raw '#!' body is
        // rejected here, and not something a composed library action gets to decide silently.
        if (this.statusReporter && this.statusContext) {
            for (const s of this.steps) {
                const owner = this._actionStepOwners.get(s.name);
                if (owner && s.onError === "stopAndFail") {
                    throw new Error(
                        `Task '${this.name}': action '${owner}' sets onError:'stopAndFail' on step ` +
                            `'${s.name}', which ends the pod before this task's status reporter runs. ` +
                            `An action cannot opt out of the exit-code contract — let the step fail ` +
                            `normally, or compose it into a task that reports no status.`,
                    );
                }
            }
        }
        this.caches = mergeByName([...(opts.caches ?? []), ...this.actions.flatMap((a) => a.caches)]);
        // Auto-register workspace for PVC-backed caches. Non-PVC backends manage their own storage.
        for (const c of this.caches) {
            const backend = c.backend ?? new PvcBackend();
            if (!backend.needsPvcWorkspace || !c.workspace) continue;
            if (!this.workspaces.some((w) => w.name === c.workspace!.name)) {
                (this.workspaces as Workspace[]).push(c.workspace);
            }
        }
        // Artifacts, producer side first: where this task publishes follows from the
        // workspaces it *declared*, before a consumed artifact's workspace is auto-mounted
        // below — otherwise consuming from elsewhere would make its own `produces` ambiguous.
        const produced = Object.entries(opts.produces ?? {}) as [string, ArtifactSource][];
        const artifacts: Record<string, TaskArtifact> = {};
        if (produced.length > 0) {
            const store = opts.artifactStore ?? new WorkspaceArtifactStore();
            const workspace = store.needsWorkspace
                ? this._resolveArtifactWorkspace(opts.artifactWorkspace)
                : undefined;
            for (const [name, source] of produced) {
                // An action output only exists in this pod, so promoting one the task never
                // composes would publish a path nothing ever wrote. Reached through the
                // object form too, which wraps the same promoted output.
                const from = typeof source === "object" && "from" in source ? source.from : source;
                if (
                    from instanceof ActionArtifactSource &&
                    !this.actions.some(a => a.name === from.action)
                ) {
                    throw new Error(
                        `Task '${this.name}': artifact '${name}' promotes output ` +
                            `'${from.output}' of action '${from.action}', which this task does ` +
                            `not compose — add the action to 'steps', or publish a path instead`,
                    );
                }
                artifacts[name] = new TaskArtifact({ name, source, producer: this, store, workspace });
            }
        }
        this.artifacts = artifacts as { readonly [K in AN]: TaskArtifact };
        this.produces = Object.values(artifacts);
        // Consumer side. A consumer mounts the workspace its artifacts live on the same way a
        // PVC-backed cache auto-registers one: the handle already knows where the file is, so
        // naming the workspace again at the call site is redundant and easy to get wrong.
        this.consumes = [...(opts.consumes ?? [])];
        for (const a of this.consumes) {
            if (!a.store.needsWorkspace || !a.workspace) continue;
            if (!this.workspaces.some(w => w.name === a.workspace!.name)) {
                (this.workspaces as Workspace[]).push(a.workspace);
            }
        }
        // A promotion action (`output.toResult(r)`) contributes the result it writes, so the
        // same Result passed in both places is bound once, not rejected as double-bound.
        this.results = mergeByName([...(opts.results ?? []), ...this.actions.flatMap((a) => a.results)]);
        for (const r of this.results) r._bindToTask(this.name, this);
        this.sidecars = opts.sidecars ?? [];
        this.volumes = mergeByName([
            ...(opts.volumes ?? []),
            ...this.actions.flatMap((a) => a.volumes),
            // Steps are separate containers: an action's declared outputs only reach the next
            // step over a pod-scoped volume, mounted on every step via the stepTemplate.
            ...(this.actions.some((a) => a.usesOutputVolume)
                ? [{ name: ACTION_VOLUME_NAME, emptyDir: {} } as TaskVolumeSpec]
                : []),
        ]);
        this.defaultLanguage = opts.defaultLanguage;
        this.annotations = opts.annotations;
        this.when = opts.when;
        this.retries = opts.retries;
        this.timeout = opts.timeout;
        this.fanOut = opts.fanOut;
        this.catalog = opts.catalog;
        this.artifactProvenance = opts.artifactProvenance;
        // Gating on a task's result (e.g. a change-detection task) auto-wires the
        // producing task into the dependency graph — no manual `needs`.
        if (opts.when instanceof Condition) {
            for (const src of opts.when.sources()) {
                if (!this.needs.includes(src)) this.needs.push(src);
            }
        }
        if (opts.fanOut) {
            const { over, as, from } = opts.fanOut;
            if (!this.params.includes(as) && !this.params.some((p) => p.name === as.name)) {
                throw new Error(
                    `Task '${this.name}': fanOut param '${as.name}' must be declared in the task's 'params'`,
                );
            }
            const src = from ?? over.owner;
            if (!src) {
                throw new Error(
                    `Task '${this.name}': fanOut.over result '${over.name}' is not bound to a task — construct the producing task first, or pass fanOut.from`,
                );
            }
            if (!this.needs.includes(src)) this.needs.push(src);
        }
    }

    /**
     * The workspace `produces` publishes onto: the one the caller named, else the task's
     * only workspace. Anything else is a guess, and a wrong guess is a file written where
     * no consumer looks.
     */
    private _resolveArtifactWorkspace(explicit?: Workspace): Workspace {
        if (explicit) return explicit;
        if (this.workspaces.length === 1) return this.workspaces[0];
        if (this.workspaces.length === 0) {
            throw new Error(
                `Task '${this.name}': 'produces' needs a workspace to publish onto — an ` +
                    `artifact has to outlive this pod — but the task declares none. Add one, ` +
                    `or set 'artifactStore' to a store that needs no workspace`,
            );
        }
        throw new Error(
            `Task '${this.name}': 'produces' is ambiguous — the task declares ` +
                `${String(this.workspaces.length)} workspaces ` +
                `(${this.workspaces.map(w => w.name).join(", ")}). Set 'artifactWorkspace' to ` +
                `the one artifacts should live on`,
        );
    }

    /**
     * Synthesizes the Tekton Task resource into the given cdk8s scope.
     *
     * @param opts - Project-level defaults, as {@link TektonicProject} supplies them. All
     *   optional: a task synthesized on its own carries the library's own defaults.
     */
    synth(
        scope: Construct,
        namespace: string,
        opts: TaskSynthOptions = {},
    ): void {
        const {
            namePrefix,
            stepSecurityContext,
            defaultLanguage: projectDefaultLanguage,
            defaultImagePullPolicy,
            injectedStepImage,
            artifactProvenance,
        } = opts;
        const resourceName = namePrefix
            ? `${namePrefix}-${this.name}`
            : this.name;
        const baseStepSecContext = {
            ...DEFAULT_STEP_SECURITY_CONTEXT,
            ...(stepSecurityContext ?? {}),
        };
        const injectedImage = normalizeInjectedStepImage(injectedStepImage);
        const ctx: BackendCtx = { taskName: this.name, defaultImage: injectedImageRef() };
        const restoreSteps = this.caches.map((c) =>
            (c.backend ?? new PvcBackend()).restoreStep(
                this._effectiveCacheSpec(c),
                ctx,
            ),
        );
        const saveSteps = this.caches
            .filter((c) => c.saveStrategy !== "finally")
            .map((c) => (c.backend ?? new PvcBackend()).saveStep(c, ctx));
        // Artifact fetch/publish steps bracket the user steps and are theirs, not the cache
        // steps': a cache is an optimisation whose failure is survivable, an artifact is a
        // declared handoff whose failure breaks a downstream task. So they take the exit-code
        // contract exactly as user steps do, below, and count toward the reported status.
        const artifactCtx = artifactStoreCtx(this.name);
        const fetchSteps = this.consumes
            .map((a) => a.store.fetchStep(a, artifactCtx))
            .filter((s): s is TaskStepSpec => s !== undefined);
        const publishSteps = this.produces.map((a) => a.store.publishStep(a, artifactCtx));
        // Provenance last, and only when asked for: it digests what the producer wrote and
        // what the consumer fetched, so both have to have happened first.
        const provenanceStep =
            (this.artifactProvenance ?? artifactProvenance ?? false)
                ? [artifactProvenanceStep(this.produces, this.consumes)].filter(
                      (s): s is TaskStepSpec => s !== undefined,
                  )
                : [];
        const ownStepNames = new Set(this.steps.map((s) => s.name));
        for (const s of [...fetchSteps, ...publishSteps, ...provenanceStep]) {
            if (ownStepNames.has(s.name)) {
                throw new Error(
                    `Task '${this.name}': injected artifact step '${s.name}' collides with a ` +
                        `step of the same name — rename the step, or the artifact it derives from`,
                );
            }
        }
        // Only the user steps' names are handed to the reporter. The cache restore/save
        // steps also run with onError:'continue', so Tekton records exit codes for them
        // too — but a failed cache save must stay non-fatal, so they are excluded.
        const reporterStep =
            this.statusReporter && this.statusContext
                ? [
                      this.statusReporter.finalStep(
                          this.statusContext,
                          [...fetchSteps, ...this.steps, ...publishSteps, ...provenanceStep].map(
                              (s) => s.name,
                          ),
                      ),
                  ]
                : [];
        // The reporter names its own step, so nothing stops it from taking a name the task
        // already uses. Tekton would reject the Task at apply time; name the culprit here.
        const takenStepNames = [
            ...restoreSteps,
            ...fetchSteps,
            ...this.steps,
            ...publishSteps,
            ...provenanceStep,
            ...saveSteps,
        ].map((s) => s.name);
        for (const s of reporterStep) {
            if (takenStepNames.includes(s.name)) {
                throw new Error(
                    `Task '${this.name}': status reporter step '${s.name}' collides with a step of ` +
                        `the same name — rename the step`,
                );
            }
        }
        // When this task reports status, the framework owns the exit-code contract:
        // user steps capture their (worst) exit code to EXIT_CODE_PATH and run with
        // onError:'continue' so the appended reporter step always runs and reads it.
        // The user body therefore just exits naturally — no hand-written plumbing.
        const reporting = Boolean(this.statusReporter && this.statusContext);
        const defaultLanguage = this.defaultLanguage ?? projectDefaultLanguage;
        const userCtx: ScriptCtx = {
            exitCodePath: EXIT_CODE_PATH,
            captureExitCode: reporting,
            taskName: this.name,
        };
        const libCtx: ScriptCtx = { exitCodePath: EXIT_CODE_PATH, captureExitCode: false };

        const renderStep = (
            s: TaskStepSpec,
            renderCtx: ScriptCtx,
            injectOnError: boolean,
        ): Record<string, unknown> => {
            const { securityContext, script, onError, ...rest } = s;
            const out: Record<string, unknown> = { ...rest };
            // Injected steps carry a marker rather than an image, so the project's choice
            // reaches them here instead of being baked in wherever they were constructed.
            out.image = resolveInjectedImage(s.image, injectedImage, {
                taskName: this.name,
                stepName: s.name,
            });
            if (script !== undefined) {
                // stepName is per-step, so it is layered on here rather than baked
                // into the shared ctx above.
                out.script = renderScript(script, { ...renderCtx, stepName: s.name }, defaultLanguage);
            }
            const effectiveOnError = onError ?? (injectOnError ? "continue" : undefined);
            if (effectiveOnError) out.onError = effectiveOnError;
            if (securityContext) out.securityContext = securityContext;
            return out;
        };

        // Tekton applies stepTemplate to steps only, so the project's default pull policy
        // cannot reach a sidecar that way — stamp it on here, letting the sidecar's own
        // setting win.
        const renderSidecar = (sc: TaskSidecarSpec): Record<string, unknown> => {
            const { script, imagePullPolicy, ...rest } = sc;
            const out: Record<string, unknown> = { ...rest };
            if (defaultImagePullPolicy || imagePullPolicy) {
                out.imagePullPolicy = imagePullPolicy ?? defaultImagePullPolicy;
            }
            if (script !== undefined) {
                // libCtx: no exit-code capture — a sidecar reports no status and outlives
                // the steps that do.
                out.script = renderScript(script, { ...libCtx, stepName: sc.name }, defaultLanguage);
            }
            return out;
        };

        const actionVolumeMounts = this.actions.some((a) => a.usesOutputVolume)
            ? [{ name: ACTION_VOLUME_NAME, mountPath: ACTION_OUTPUT_DIR }]
            : [];

        const steps = [
            ...restoreSteps.map((s) => renderStep(s, libCtx, false)),
            ...fetchSteps.map((s) => renderStep(s, userCtx, reporting)),
            ...this.steps.map((s) => renderStep(s, userCtx, reporting)),
            ...publishSteps.map((s) => renderStep(s, userCtx, reporting)),
            ...provenanceStep.map((s) => renderStep(s, userCtx, reporting)),
            ...saveSteps.map((s) => renderStep(s, libCtx, false)),
            ...reporterStep.map((s) => renderStep(s, libCtx, false)),
        ];
        new ApiObject(scope, this.name, {
            apiVersion: TEKTON_API_V1,
            kind: "Task",
            metadata: {
                name: resourceName,
                namespace,
                ...(this.annotations && { annotations: this.annotations }),
            },
            spec: {
                stepTemplate: {
                    securityContext: baseStepSecContext,
                    computeResources: DEFAULT_STEP_RESOURCES,
                    ...(defaultImagePullPolicy && { imagePullPolicy: defaultImagePullPolicy }),
                    ...(this.stepTemplate ?? {}),
                    // Mounted on every step rather than on the producing one, so a later
                    // hand-written step can read `${action.outputs.x}` with nothing to declare.
                    ...(actionVolumeMounts.length > 0 && {
                        volumeMounts: [
                            ...actionVolumeMounts,
                            ...((this.stepTemplate?.volumeMounts as TaskStepSpec["volumeMounts"]) ?? []),
                        ],
                    }),
                },
                ...(this.params.length > 0 && {
                    params: this.params.map((p) => p.toSpec()),
                }),
                ...(this.workspaces.length > 0 && {
                    workspaces: this.workspaces.map((w) => w.toSpec()),
                }),
                ...(this.results.length > 0 && {
                    results: this.results.map((r) => r.toSpec()),
                }),
                steps,
                ...(this.sidecars.length > 0 && {
                    sidecars: this.sidecars.map((sc) => renderSidecar(sc)),
                }),
                ...(this.volumes.length > 0 && {
                    volumes: this.volumes,
                }),
            },
        });
    }

    /**
     * Returns standalone Task objects for caches that use `saveStrategy: "finally"`.
     * These tasks are intended to be wired into the pipeline's `finally` block so
     * they run in their own pod after the build pod has terminated.
     */
    getCacheFinallyTasks(): Task[] {
        const ctx: BackendCtx = { taskName: this.name, defaultImage: injectedImageRef() };
        return this.caches
            .filter((c) => c.saveStrategy === "finally")
            .map((c) => {
                const backend = c.backend ?? new PvcBackend();
                // PVC backends prepend the cache workspace so hash files survive across pods.
                // Non-PVC backends (GCS etc.) use only the source task's workspaces.
                const taskWorkspaces = backend.needsPvcWorkspace
                    ? [c.workspace!, ...this.workspaces.filter((w) => w.name !== c.workspace!.name)]
                    : [...this.workspaces];
                return new TaskDef({
                    name: `save-${c.name}-cache-${this.name}`,
                    workspaces: taskWorkspaces,
                    steps: [backend.saveStep(c, ctx)],
                    stepTemplate: this.stepTemplate,
                });
            });
    }

    /**
     * @internal Marks a cache as living on a workspace shared with other tasks in a pipeline.
     * Called by {@link Pipeline} at construction; the flag only widens the default, so a task
     * shared between pipelines keeps the safest behaviour.
     */
    _markSharedWorkspaceCache(cacheName: string): void {
        this._sharedWorkspaceCaches.add(cacheName);
    }

    /**
     * The cache spec as synthesized: an explicit `skipRestoreIfPathsExist` always wins, and
     * a cache flagged by {@link _markSharedWorkspaceCache} defaults to skipping restore over
     * existing paths.
     */
    private _effectiveCacheSpec(c: TaskCacheSpec): TaskCacheSpec {
        if (c.skipRestoreIfPathsExist !== undefined) return c;
        if (!this._sharedWorkspaceCaches.has(c.name)) return c;
        return { ...c, skipRestoreIfPathsExist: true };
    }

    /** @internal Generates the pipeline task spec used inside a Pipeline resource. */
    _toPipelineTaskSpec(
        runAfterNames: string[],
        namePrefix?: string,
    ): Record<string, unknown> {
        const taskRefName = namePrefix
            ? `${namePrefix}-${this.name}`
            : this.name;
        const spec: Record<string, unknown> = {
            name: this.name,
            taskRef: { kind: "Task", name: taskRefName },
        };
        if (this.params.length > 0) {
            spec.params = this.params.map((p) => ({
                name: p.name,
                value: p.pipelineExpression ?? `$(params.${p.name})`,
            }));
        }
        if (this.workspaces.length > 0) {
            spec.workspaces = this.workspaces.map((w) => ({
                name: w.name,
                workspace: w.name,
            }));
        }
        if (runAfterNames.length > 0) {
            spec.runAfter = runAfterNames;
        }
        if (this.when) {
            const when = normalizeWhen(this.when);
            if (when.length) spec.when = when;
        }
        if (this.retries !== undefined) {
            spec.retries = this.retries;
        }
        if (this.timeout !== undefined) {
            spec.timeout = this.timeout;
        }
        if (this.fanOut) {
            const matrixName = this.fanOut.as.name;
            if (Array.isArray(spec.params)) {
                spec.params = (spec.params as { name: string }[]).filter(
                    (p) => p.name !== matrixName,
                );
                if ((spec.params as unknown[]).length === 0) delete spec.params;
            }
            spec.matrix = { params: [{ name: matrixName, value: this.fanOut.over.arrayRef }] };
        }
        return spec;
    }
}

// Backward-compatible aliases — preserves all existing `new Task()` and
// `instanceof Task` usage without any changes to call sites.
export const Task = TaskDef;
export type Task = TaskDef;
