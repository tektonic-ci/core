import type { TaskCacheSpec, TaskStepSpec } from "../core/task";
import type { BackendCtx, CacheBackend } from "../core/cache-backend";
import { injectedImageRef } from "../core/injected-image";
import type { Script } from "../script";
import {
    threadFlag,
    hashExpr,
    cacheScript,
    stagedExtract,
    COMPRESSED_CACHE_LANGUAGE,
    PORTABLE_CACHE_LANGUAGE,
} from "./shared";

/**
 * PVC-based cache backend (the default when no `backend` is specified).
 *
 * Stores cache archives on a Kubernetes PersistentVolumeClaim.
 * The workspace must be declared on the task via `TaskCacheSpec.workspace`.
 */
export class PvcBackend implements CacheBackend {
    readonly type = "pvc" as const;
    readonly needsPvcWorkspace = true as const;

    restoreStep(spec: TaskCacheSpec, ctx: BackendCtx): TaskStepSpec {
        return {
            name: `restore-${spec.name}-cache`,
            image: spec.image ?? this._defaultImage(spec, ctx),
            script: this._makeRestoreScript(spec, ctx.taskName),
            ...(spec.workingDir ? { workingDir: spec.workingDir } : {}),
            ...(spec.computeResources ? { computeResources: spec.computeResources } : {}),
        };
    }

    saveStep(spec: TaskCacheSpec, ctx: BackendCtx): TaskStepSpec {
        return {
            name: `save-${spec.name}-cache`,
            image: spec.image ?? this._defaultImage(spec, ctx),
            script: this._makeSaveScript(spec, ctx.taskName),
            onError: "continue" as const,
            ...(spec.workingDir ? { workingDir: spec.workingDir } : {}),
            ...(spec.computeResources ? { computeResources: spec.computeResources } : {}),
        };
    }

    /**
     * The project's injected-step image, asking it for what this cache actually needs: a
     * compressed cache shells out to `tar` and `zstd` from nushell, an uncompressed one is
     * portable POSIX sh and ends at `ctx.defaultImage`.
     */
    private _defaultImage(spec: TaskCacheSpec, ctx: BackendCtx): string {
        return spec.compress ? injectedImageRef("nushell", "tar", "zstd") : ctx.defaultImage;
    }

    private _hashFilePath(c: TaskCacheSpec, taskName?: string): string {
        const wsPath = `$(workspaces.${c.workspace!.name}.path)`;
        if (c.saveStrategy === "finally") {
            return `${wsPath}/.cache-${c.name}-hash${taskName ? `-${taskName}` : ""}`;
        }
        return `/tekton/home/.cache-${c.name}-hash`;
    }

    private _makeRestoreScript(c: TaskCacheSpec, taskName?: string): Script {
        const wsName = c.workspace!.name;
        const wsPath = `$(workspaces.${wsName}.path)`;
        const hashFile = this._hashFilePath(c, taskName);
        const flag = threadFlag(c);
        const label = `restore-${c.name}-cache`;
        const skipIfExists = c.skipRestoreIfPathsExist ?? false;

        if (c.compress) {
            const expr = hashExpr(c);
            const pathList = c.paths.map((p) => `"${p}"`).join(", ");
            // Indented to sit inside the `if ($archive | path exists)` block.
            const stagedExtractBody = stagedExtract(
                c,
                label,
                `^zstd -d ${flag} -c $archive | ^tar xf - -C $stage -o --no-same-permissions`,
                // Save skips a hash whose archive exists, so an unextractable one would fail
                // every run until removed by hand. Drop it and carry on as a miss instead.
                `rm -f $archive
log $"${label}: removed unextractable archive, treating as a miss ($hash)"
exit 0`,
            )
                .split("\n")
                .map((l) => (l.length > 0 ? `  ${l}` : l))
                .join("\n");
            const skipGuard = skipIfExists
                ? `if ([${pathList}] | any { |p| $p | path exists }) {
  log $"${label}: paths already exist, skipping restore ($hash)"
  exit 0
}
`
                : "";
            return cacheScript(
                `${expr}
$hash | save -f ${hashFile}
${skipGuard}let archive = $"${wsPath}/($hash).tar.zst"

if ($archive | path exists) {
  let archive_size = (ls $archive | get size.0)
  log $"${label}: hit ($hash) size=($archive_size)"
  let t0 = (date now)
${stagedExtractBody}
  let elapsed = (((date now) - $t0) | into int) / 1_000_000_000
  log $"${label}: restored in ($elapsed)s"
} else {
  log $"${label}: miss ($hash)"
}`,
                COMPRESSED_CACHE_LANGUAGE,
            );
        }
        // Uncompressed PVC restore — portable POSIX sh, no nushell required.
        const keyFiles = c.key.join(" ");
        const copyPaths = c.paths
            .map((p) => `  [ -e "$CACHE_DIR/${p}" ] && cp -r "$CACHE_DIR/${p}" "./${p}" || true`)
            .join("\n");
        const hashCmd =
            c.key.length === 0
                ? `HASH=$(echo -n "" | sha256sum | cut -c1-16)`
                : `HASH=$(cat ${keyFiles} | sha256sum | cut -c1-16)`;
        const skipGuardSh = skipIfExists
            ? c.paths.map((p) => `[ -e "./${p}" ]`).join(" || ")
            : "";
        const skipCheckSh = skipIfExists
            ? `if ${skipGuardSh}; then
  log "${label}: paths already exist, skipping restore \$HASH"
  exit 0
fi
`
            : "";
        return cacheScript(
            `set -e
${hashCmd}
echo "$HASH" > ${hashFile}
${skipCheckSh}CACHE_DIR="${wsPath}/$HASH"
if [ -d "$CACHE_DIR" ]; then
  log "${label}: hit $HASH"
${copyPaths}
else
  log "${label}: miss $HASH"
fi`,
            PORTABLE_CACHE_LANGUAGE,
        );
    }

    private _makeSaveScript(c: TaskCacheSpec, taskName?: string): Script {
        const wsName = c.workspace!.name;
        const wsPath = `$(workspaces.${wsName}.path)`;
        const hashFile = this._hashFilePath(c, taskName);
        const compressionLevel = c.compressionLevel ?? 1;
        const maxEntries = c.maxEntries ?? 3;
        const forceSave = c.forceSave ?? false;
        const flag = threadFlag(c);
        const label = `save-${c.name}-cache`;

        if (c.compress) {
            const pathList = c.paths.map((p) => `"${p}"`).join(", ");
            const skipExisting = forceSave
                ? ""
                : `if ($archive | path exists) { log $"${label}: ($hash) exists, skipping"; exit 0 }\n`;
            return cacheScript(
                `let hash = (try { open --raw ${hashFile} | str trim } catch { "" })
if ($hash | is-empty) { log "${label}: no hash, skipping"; exit 0 }

let archive = $"${wsPath}/($hash).tar.zst"
${skipExisting}
let paths = [${pathList}] | where { |p| ($p | path exists) }
if ($paths | is-empty) { log "${label}: no paths to cache"; exit 0 }

for p in $paths { ^chmod -R u+w $p }

let max = ${maxEntries}
if $max > 0 {
  let entries = (try { ls ${wsPath}/*.tar.zst | sort-by modified | reverse | skip $max } catch { [] })
  for e in $entries { log $"${label}: evicting ($e.name | path basename)"; rm $e.name }
}

let uncompressed = ($paths | each { |p| try { du $p | get apparent.0 | into int } catch { 0 } } | math sum)
log $"${label}: compressing (($uncompressed / 1_000_000) | math round --precision 1)MB uncompressed ..."
let t0 = (date now)
# Write to a temp path and rename into place: a step killed mid-write (OOM, eviction,
# timeout) must never leave a truncated archive at the real hash-keyed path, since the
# skip-if-exists guard above means a corrupt archive there would never self-heal.
let tmp = $"($archive).tmp.(random uuid)"
# nushell aborts the enclosing block as soon as any external command in the pipe
# reports a non-zero exit (e.g. tar failing to read one of $paths), so cleanup must
# live in a catch — code placed after the pipe but outside try/catch never runs.
# --mode=u+w stores every entry owner-writable. The chmod above runs before tar, so a
# concurrent task can still add a read-only dir (Go's 0555 module cache) in between, and
# extracting under such a dir fails with "Permission denied".
try {
  ^tar cf - --mode=u+w ...$paths | ^zstd -${compressionLevel} ${flag}${forceSave ? " -f" : ""} -o $tmp
} catch { |e|
  rm -f $tmp
  log $"${label}: compress failed \(($e.msg)\), discarding partial archive"
  exit 1
}
mv -f $tmp $archive
let elapsed = (((date now) - $t0) | into int) / 1_000_000_000
let compressed = (ls $archive | get size.0)
let ratio = ($uncompressed / ($compressed | into int) | math round --precision 1)
log $"${label}: saved ($compressed) ratio=($ratio)x in ($elapsed)s"`,
                COMPRESSED_CACHE_LANGUAGE,
            );
        }
        // Uncompressed PVC save — portable POSIX sh, no nushell required.
        // Build into a temp dir and rename into place so a step killed mid-copy never
        // leaves a partial $CACHE_DIR behind (the restore side only checks `-d
        // "$CACHE_DIR"`, so a half-written dir would be treated as a valid hit).
        const copyPaths = c.paths.map((p) => `  cp -r "./${p}" "$TMP_DIR/${p}"`).join("\n");
        const saveCondition = forceSave
            ? `log "${label}: saving cache ($HASH)"\n  mkdir -p "$TMP_DIR"\n${copyPaths}\n  rm -rf "$CACHE_DIR"\n  mv "$TMP_DIR" "$CACHE_DIR"`
            : `if [ ! -d "$CACHE_DIR" ]; then\n  log "${label}: saving cache ($HASH)"\n  mkdir -p "$TMP_DIR"\n${copyPaths}\n  if [ -d "$CACHE_DIR" ]; then\n    rm -rf "$TMP_DIR"\n  else\n    mv "$TMP_DIR" "$CACHE_DIR"\n  fi\nfi`;
        return cacheScript(
            `HASH=$(cat ${hashFile} 2>/dev/null || echo "")
[ -z "$HASH" ] && exit 0
CACHE_DIR="${wsPath}/$HASH"
TMP_DIR="${wsPath}/.tmp-$HASH-$$"
${saveCondition}`,
            PORTABLE_CACHE_LANGUAGE,
        );
    }
}
