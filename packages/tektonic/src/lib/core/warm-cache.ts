import type { TaskCacheSpec } from "./task";

/**
 * @internal Symbol key linking a cache spec back to the {@link WarmCache} it came from.
 * A symbol survives the object spreads specs pass through on their way to synthesis
 * (task merging, presets, the effective-spec defaulting) and is invisible to backends,
 * so it never reaches the generated YAML.
 */
export const WARM_CACHE: unique symbol = Symbol("tektonic.warmCache");

/** @internal The role a spec plays in its {@link WarmCache}. */
export interface WarmCacheLink {
    cache: WarmCache;
    role: "producer" | "consumer";
}

/** @internal Reads the {@link WarmCache} link off a cache spec, if it has one. */
export function warmCacheLink(spec: TaskCacheSpec): WarmCacheLink | undefined {
    return (spec as TaskCacheSpec & { [WARM_CACHE]?: WarmCacheLink })[WARM_CACHE];
}

/** Options for {@link WarmCache.consumer}. */
export interface WarmCacheConsumerOptions {
    /**
     * Save even when an archive for the current key already exists. Set it on a consumer
     * that adds to the tree the producer left — a test task pulling in test-only modules —
     * so what it adds is written back. Defaults to `false`.
     */
    forceSave?: boolean;
}

/**
 * One cache that a single producer task warms and N consumer tasks reuse on the same
 * workspace. Created by {@link warmCache}.
 */
export interface WarmCache {
    /** The cache's name, as in {@link TaskCacheSpec.name}. */
    readonly name: string;
    /**
     * Spec for the one task that warms the tree: restores and saves normally. Exactly one
     * task in a pipeline that uses a consumer of this cache must declare it.
     */
    readonly producer: TaskCacheSpec;
    /**
     * Spec for a task that reuses the producer's tree. Restore is skipped when the paths
     * are already populated, so it never swaps a tree out from under a concurrent task.
     * {@link Pipeline} fails synthesis unless the producer is ordered before the consumer
     * — that ordering is what guarantees the paths are populated.
     */
    consumer(opts?: WarmCacheConsumerOptions): TaskCacheSpec;
}

/**
 * Declares a cache once for one producer task and any number of consumers, instead of
 * hand-deriving a spec per task that differs only in `skipRestoreIfPathsExist` and
 * `forceSave`.
 *
 * ```ts
 * const goCache = warmCache({ name: 'go', key: ['go.sum'], paths: ['.go-mod', '.go-build'], ... });
 * const build = new Task({ caches: [goCache.producer], ... });
 * const test  = new Task({ needs: [build], caches: [goCache.consumer({ forceSave: true })], ... });
 * ```
 *
 * The declaration owns `skipRestoreIfPathsExist`, so `spec` must leave it unset.
 */
export function warmCache(spec: TaskCacheSpec): WarmCache {
    if (spec.skipRestoreIfPathsExist !== undefined) {
        throw new Error(
            `warmCache '${spec.name}': skipRestoreIfPathsExist is set by the declaration ` +
            `(off for the producer, on for consumers) — remove it from the spec.`,
        );
    }
    const cache = {
        name: spec.name,
        consumer: (opts: WarmCacheConsumerOptions = {}) => ({
            ...spec,
            skipRestoreIfPathsExist: true,
            ...(opts.forceSave !== undefined ? { forceSave: opts.forceSave } : {}),
            [WARM_CACHE]: { cache, role: "consumer" },
        }) as TaskCacheSpec,
    } as { -readonly [K in keyof WarmCache]: WarmCache[K] };
    cache.producer = { ...spec, [WARM_CACHE]: { cache, role: "producer" } } as TaskCacheSpec;
    return cache;
}
