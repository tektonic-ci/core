import {
    Task,
    GitPipeline,
    TektonicProject,
    TRIGGER_EVENTS,
    PAC_PARAMS,
    DEFAULT_BASE_IMAGE,
    Workspace,
    sh,
    nu,
} from "../packages/tektonic/dist/index.js";
// The GitHub reporter is a separate package: this file consumes it exactly as any other
// project does, through its own package root.
import { GitHubStatusReporter } from "@tektonic-ci/reporter-github";

// ─── Images ──────────────────────────────────────────────────────────────────
const nodeImage = "ghcr.io/pfenerty/apko-cicd/nodejs:24";
const syftImage = "ghcr.io/pfenerty/apko-cicd/syft:1.51.0";
const grypeImage = "ghcr.io/pfenerty/apko-cicd/grype:0.117.0";

// ─── Params ──────────────────────────────────────────────────────────────────
// The PAC-injected params are typed handles rather than hand-declared Params plus raw
// `$(params.…)` strings — the project binds them on every PipelineRun.
const sourceBranchParam = PAC_PARAMS.sourceBranch;

// ─── Status reporter ─────────────────────────────────────────────────────────
// Under PAC, reuse the git-auth token via the pod env (see podTemplateEnv below)
// instead of injecting a separate github-token secret per step.
const statusReporter = new GitHubStatusReporter({ skipTokenInjection: true });

// ─── Cache workspace ────────────────────────────────────────────────────────
// CI runs on the homelab Talos cluster, so caches use the default PVC backend. Every cache
// archives into this one workspace, keyed by cache name. Its claim (`tektonic-cache`, on
// local-path) is created by homelab in talos-cluster/flux/apps/tektonic-ci. tektonic emits
// only the `claimName` reference, not the claim itself.
const cacheWs = new Workspace({ name: "cache" });

// ─── Tasks ───────────────────────────────────────────────────────────────────
const npmTest = new Task({
    name: "test-npm",
    statusReporter,
    caches: [
        {
            name: "npm",
            key: ["package-lock.json"],
            paths: ["node_modules"],
            workspace: cacheWs,
            compress: true,
            workingDir: "$(workspaces.workspace.path)",
        },
    ],
    steps: [
        {
            // The cache is keyed on package-lock.json alone, which is correct — the lock is
            // what `npm ci` installs from. But that makes a package.json-only change (a
            // dependency bump whose lock refresh failed, say) a cache hit: node_modules is
            // restored, the `npm ci` below is skipped, and the tests silently run against the
            // old dependency tree. This dry run costs a few seconds, never writes anything and
            // runs whether or not the cache hit, so drift fails the build instead of hiding.
            name: "check-lockfile",
            image: nodeImage,
            workingDir: "$(workspaces.workspace.path)",
            script: sh`
                if npm ci --dry-run --ignore-scripts --no-audit --no-fund >/dev/null 2>&1; then
                  echo "check-lockfile: package-lock.json is in sync with package.json"
                  exit 0
                fi
                echo "check-lockfile: package-lock.json does not match package.json" >&2
                echo "check-lockfile: run 'npm install' and commit the updated lock file" >&2
                echo "check-lockfile: npm reported:" >&2
                npm ci --dry-run --ignore-scripts --no-audit --no-fund >&2
            `,
        },
        {
            name: "test",
            image: nodeImage,
            workingDir: "$(workspaces.workspace.path)",
            // The exit-code contract is applied by the sh wrapper (the task reports status),
            // so the body just runs and exits naturally — no hand-written EC plumbing, and
            // no explicit onError: the framework sets it on every step of a reporting task.
            script: sh`
                set -e
                if [ ! -d node_modules ]; then npm ci; fi
                npm test
            `,
        },
        {
            // .tekton/ is generated from this file, so its image tags are output, not
            // source — which is exactly how Renovate came to bump the emitted YAML and
            // leave the pins above behind (see renovate.json). `tektonic check` is the
            // guard: it synthesizes into a temp dir and diffs against what is committed,
            // so the manifests the cluster runs from can never quietly fall behind the
            // code that describes them. Its exit code reaches the reporter like any
            // other step's, so drift turns the GitHub check red.
            name: "check-manifests",
            image: nodeImage,
            workingDir: "$(workspaces.workspace.path)",
            script: sh`
                set -e
                if [ ! -d node_modules ]; then npm ci; fi
                npm run check
            `,
        },
        {
            // Anyone can write a provider, so core can't find out whether a change breaks
            // one by building them all. This asks the compiler instead: it compiles the
            // API of the last published core against this tree's, export by export, and
            // fails on a break unless packages/tektonic/package.json already bumps the
            // major. It also fails when packages/tektonic/api/ no longer matches the build,
            // so every public API change shows up as a reviewed diff.
            // See scripts/api-compat.mjs.
            name: "check-api",
            image: nodeImage,
            workingDir: "$(workspaces.workspace.path)",
            script: sh`
                set -e
                if [ ! -d node_modules ]; then npm ci; fi
                npm run api:check
            `,
        },
    ],
});

const npmBuild = new Task({
    name: "build-npm",
    needs: [npmTest],
    statusReporter,
    caches: [
        {
            name: "npm",
            key: ["package-lock.json"],
            paths: ["node_modules"],
            workspace: cacheWs,
            compress: true,
            workingDir: "$(workspaces.workspace.path)",
        },
    ],
    steps: [
        {
            name: "build",
            image: nodeImage,
            workingDir: "$(workspaces.workspace.path)",
            script: sh`
                set -e
                if [ ! -d node_modules ]; then npm ci; fi
                npm run build
            `,
        },
    ],
});

const anchoreScann = new Task({
    name: "anchore-scan",
    params: [sourceBranchParam, PAC_PARAMS.repoFullName, PAC_PARAMS.revision],
    statusReporter,
    caches: [
        {
            name: "grype-db",
            key: [],
            paths: ["grype-db"],
            workspace: cacheWs,
            compress: true,
            forceSave: true,
            maxEntries: 1,
            workingDir: "$(workspaces.workspace.path)",
        },
    ],
    steps: [
        {
            name: "generate-sbom",
            image: syftImage,
            // `log` comes from the nushell plugin's preamble — no hand-written def.
            script: nu`
                log "generate-sbom: generating SBOM from package-lock.json"
                let start = (date now)

                ^syft file:package-lock.json -o cyclonedx-json=sbom.cyclonedx.json -o syft-table

                let elapsed = ((date now) - $start | into int) / 1_000_000_000
                log $"generate-sbom: done in ($elapsed)s"

                if ("sbom.cyclonedx.json" | path exists) {
                  let size = (ls sbom.cyclonedx.json | get size.0)
                  log $"generate-sbom: sbom size: ($size)"
                } else {
                  log "generate-sbom: warning: sbom.cyclonedx.json not found"
                }
            `,
        },
        {
            name: "scan",
            image: grypeImage,
            env: [
                {
                    name: "GRYPE_DB_CACHE_DIR",
                    value: "$(workspaces.workspace.path)/grype-db",
                },
            ],
            script: nu`
                log "grype-scan: scanning sbom.cyclonedx.json for vulnerabilities"
                let start = (date now)

                # Run grype directly so stdout/stderr stream in real time. The step's failure
                # must not stop the pipeline (the SARIF still needs uploading), and its exit
                # code reaches the reporter through the contract file and Tekton's own
                # /tekton/steps/step-scan/exitCode.
                ^grype -v sbom:./sbom.cyclonedx.json -o sarif=./scan.sarif

                let elapsed = ((date now) - $start | into int) / 1_000_000_000
                log $"grype-scan: done in ($elapsed)s"

                if ("scan.sarif" | path exists) {
                  let size = (ls scan.sarif | get size.0)
                  log $"grype-scan: sarif size: ($size)"
                }
            `,
            onError: "continue",
        },
        {
            name: "upload-sarif",
            image: DEFAULT_BASE_IMAGE,
            // GITHUB_TOKEN is provided at the PipelineRun pod level via podTemplateEnv
            // (PAC's {{ git_auth_secret }}) — see the TektonicProject config below.
            // The grype exit code no longer needs propagating by hand: the reporter reads
            // Tekton's own per-step exit codes, so a failing scan step turns the check red
            // whatever this step does.
            script: nu`
                if not ("scan.sarif" | path exists) or (ls scan.sarif | get size.0) == 0B {
                  log "upload-sarif: no sarif to upload, skipping"
                  exit 0
                }

                let ref_raw = "${sourceBranchParam}"
                let ref = if ($ref_raw | str starts-with "refs/") { $ref_raw } else { $"refs/heads/($ref_raw)" }
                log $"upload-sarif: ref: ($ref)"

                # Base64-encode the gzipped SARIF
                let sarif_b64 = (open --raw scan.sarif | ^gzip -c | encode base64)
                log $"upload-sarif: payload: (($sarif_b64 | str length) / 1024 | math round)KB base64"

                let url = "https://api.github.com/repos/${PAC_PARAMS.repoFullName}/code-scanning/sarifs"
                let body = {
                  commit_sha: "${PAC_PARAMS.revision}",
                  ref: $ref,
                  sarif: $sarif_b64,
                }

                log $"upload-sarif: POST ($url)"

                try {
                  http post $url $body -t application/json -H [
                    Authorization $"token ($env.GITHUB_TOKEN)"
                    Accept "application/vnd.github+json"
                  ]
                  log "upload-sarif: uploaded"
                } catch { |e|
                  log $"upload-sarif: upload failed: ($e.msg)"
                }
            `,
            onError: "continue",
        },
    ],
});


// ─── Pipelines ───────────────────────────────────────────────────────────────
const pushPipeline = new GitPipeline({
    name: "npm-push",
    trigger: { rules: [{ on: TRIGGER_EVENTS.PUSH }] },
    tasks: [npmTest, anchoreScann],
});

const prPipeline = new GitPipeline({
    name: "npm-pull-request",
    trigger: { rules: [{ on: TRIGGER_EVENTS.PULL_REQUEST }] },
    tasks: [npmTest, npmBuild, anchoreScann],
});

// ─── Synthesize ──────────────────────────────────────────────────────────────
// In-repo PAC PipelineRun templates under .tekton/, read by the PAC operator.
// The PipelineRun ServiceAccount ("tekton-triggers") and the cache claim are created by
// homelab (talos-cluster/flux/apps/tektonic-ci), along with the PAC Repository — so no
// `repository` here: one owner for the CR, and nothing but Tekton resources under .tekton/.
new TektonicProject({
    name: "tektonic",
    namespace: "tektonic-ci",
    pipelines: [pushPipeline, prPipeline],
    outdir: ".tekton",
    workspaceStorageSize: "3Gi",
    // The cluster's default class, nfs-client, has no running provisioner, so its claims
    // never bind. local-path is what ocidex uses too.
    workspaceStorageClass: "local-path",
    caches: [{ workspace: cacheWs, storageSize: "5Gi", storageClassName: "local-path" }],
    // Image for the steps tektonic injects (git clone, cache restore/save, status
    // reporting). The library falls back to a neutral public image providing sh + git
    // only; this project's compressed caches and status reporter need nushell, tar and
    // zstd, so it names an image that has them.
    injectedStepImage: DEFAULT_BASE_IMAGE,
    // Provide the GitHub token (for status reporting + SARIF upload) via PAC's git-auth
    // secret at the pod level, so every step sees GITHUB_TOKEN.
    podTemplateEnv: [
        {
            name: "GITHUB_TOKEN",
            valueFrom: {
                secretKeyRef: { name: "{{ git_auth_secret }}", key: "git-provider-token" },
            },
        },
    ],
});
