// Core API
export { Param } from "./lib/core/param";
export type { ParamOptions } from "./lib/core/param";
export { Workspace } from "./lib/core/workspace";
export type { WorkspaceOptions } from "./lib/core/workspace";
export { Task, TaskDef } from "./lib/core/task";
export type { TaskLike, TaskOptions, TaskStepSpec, TaskStepInput, TaskCacheSpec, TaskSidecarSpec, TaskVolumeSpec, ImagePullPolicy, TaskSynthOptions } from "./lib/core/task";
export { warmCache } from "./lib/core/warm-cache";
export type { WarmCache, WarmCacheConsumerOptions } from "./lib/core/warm-cache";
export { defineAction, Action, ActionOutput, ACTION_OUTPUT_DIR, ACTION_VOLUME_NAME } from "./lib/core/action";
// Artifacts: the declared, cross-pod counterpart of an action's pod-internal outputs.
// See docs/adr/0001-artifacts-and-dependencies.md.
export {
    TaskArtifact,
    ActionArtifactSource,
    WorkspaceArtifactStore,
    ARTIFACT_DIR,
} from "./lib/core/artifact";
export type { ArtifactSource, ArtifactSpec, ArtifactStore, ArtifactStoreCtx } from "./lib/core/artifact";
export { artifactProvenanceStep, artifactUri, ARTIFACT_PROVENANCE_STEP } from "./lib/core/artifact-provenance";
export type {
    ActionDefinition,
    ActionCtx,
    ActionOptions,
    ActionOutputs,
    ActionStepSpec,
    ActionContribution,
    ActionPromotionOptions,
} from "./lib/core/action";
export { Result } from "./lib/core/result";
export type { ResultOptions } from "./lib/core/result";
export { ChainsImage } from "./lib/core/chains-image";
export type { ChainsImageOptions } from "./lib/core/chains-image";
export { HubTaskRef } from "./lib/core/hub-task-ref";
export type { HubTaskRefOptions } from "./lib/core/hub-task-ref";
export type { CacheBackend, BackendCtx } from "./lib/core/cache-backend";
export { PvcBackend } from "./lib/cache/pvc-backend";

// Supported helpers for cache-backend authors. Every backend hashes its key files and
// pipes archives through zstd the same way; a backend that reimplements them drifts, and
// a drifted hash is a silent cache miss rather than an error. See docs/cache-backends.md.
export {
    cacheScript,
    hashExpr,
    threadFlag,
    stagedExtract,
    COMPRESSED_CACHE_LANGUAGE,
    PORTABLE_CACHE_LANGUAGE,
} from "./lib/cache/shared";
export { gated, GatedTask, unwrapGated } from "./lib/core/pipeline-task";
export { PAC_PARAMS, PAC_PARAM_BINDINGS, PAC_INJECTED_PARAMS, PAC_EVENT_ENV } from "./lib/targets/pac/params";
export { serial, withConcurrency } from "./lib/core/scheduling";
export { taskPreset } from "./lib/core/task-preset";
export type { TaskPresetDefaults } from "./lib/core/task-preset";
export type { WhenExpression, MatrixSpec, PipelineTaskOverrides, PipelineTaskNode } from "./lib/core/pipeline-task";
export {
    Condition,
    equals,
    notEquals,
    isIn,
    notIn,
    matches,
    and,
    or,
    not,
    normalizeWhen,
    onBranch,
    onBranches,
    onBranchMatching,
    GIT_BRANCH_REF,
} from "./lib/core/condition";
export type { Expressable, WhenClause, CelWhenExpression } from "./lib/core/condition";
export { onChanges } from "./lib/core/changes";
export type { OnChangesOptions } from "./lib/core/changes";
export { Pipeline } from "./lib/core/pipeline";
export type { PipelineOptions } from "./lib/core/pipeline";
export { globToRegex } from "./lib/core/trigger";
export type { PipelineTrigger, TriggerRule } from "./lib/core/trigger";
export { GitPipeline } from "./lib/core/git-pipeline";
export type { GitPipelineOptions } from "./lib/core/git-pipeline";
export { TektonicProject } from "./lib/core/tektonic-project";
export type { TektonicProjectOptions, CacheSpec } from "./lib/core/tektonic-project";

// Synthesis targets
export type {
    SynthTarget,
    SynthModel,
    SynthDefaults,
    BuiltPipeline,
    BuiltTask,
    EmittedFile,
    PodEnvVar,
} from "./lib/core/synth-target";
export { PacTarget, triggerAnnotations, PAC_ANNOTATION_PREFIX } from "./lib/targets/pac";
export type { PacTargetOptions, RepositoryConfig, RepositoryGitProvider } from "./lib/targets/pac";
export { TektonTarget, pipelineManifest } from "./lib/targets/tekton";
export type { TektonTargetOptions, PipelineManifestOptions } from "./lib/targets/tekton";
export { HubTarget, PUBLIC_REGISTRIES, catalogProblems, catalogReadme, registryOf } from "./lib/targets/hub";
export type { HubTargetOptions, CatalogReadmeOptions } from "./lib/targets/hub";

// Catalog publication: the metadata a task carries to become a publishable catalog entry.
export {
    CATALOG_CATEGORIES,
    DEFAULT_CATALOG_PLATFORMS,
    DEFAULT_MIN_PIPELINES_VERSION,
} from "./lib/core/catalog";
export type { CatalogCategory, CatalogMetadata } from "./lib/core/catalog";
export { TRIGGER_EVENTS } from "./lib/core/trigger-events";
export type { StatusReporter } from "./lib/core/status-reporter";

// Scripting
export { sh, bash, nu, py, script, Script, fragment, Fragment, embedSh, rawScript, RawScript, unsafeAllowExit, languageFor, dedent, renderScript, Sh, Bash, Nushell, Python, EXIT_CODE_PATH, stepExitCodePath } from "./lib/script";
export { registerLanguage, unregisterLanguage, registeredLanguageNames, registeredExtensions, languageNameForExtension } from "./lib/script";
export { scriptFromFile, lintCommandForFile, languageNameForFile } from "./lib/script/from-file";
export type { ScriptLanguage, ScriptCtx, ScriptInput, ScriptObject, ScriptOptions, EmbedShOptions, LanguageName, KnownLanguageName, ScriptTag, RegisterLanguageOptions } from "./lib/script";

// Re-exported from cdk8s / constructs so downstream projects depend only on tektonic
export { App, Chart, ApiObject } from "cdk8s";
export type { AppProps, ChartProps } from "cdk8s";
export { Construct } from "constructs";

// Injected-step images: the seam every step tektonic injects resolves its image through.
export {
    injectedImageRef,
    DEFAULT_INJECTED_STEP_IMAGE,
} from "./lib/core/injected-image";
export type {
    ImageCapability,
    InjectedStepImage,
    InjectedStepImageSpec,
} from "./lib/core/injected-image";

// Constants
export {
    TEKTON_API_V1,
    PAC_API,
    DEFAULT_POD_SECURITY_CONTEXT,
    DEFAULT_STEP_SECURITY_CONTEXT,
    RESTRICTED_STEP_SECURITY_CONTEXT,
    DEFAULT_STEP_RESOURCES,
    DEFAULT_BASE_IMAGE,
    TEKTON_HOME,
} from "./lib/constants";
