import { TRIGGER_EVENTS } from "../../core/trigger-events";
import { globToRegex, toList } from "../../core/trigger";
import type { PipelineTrigger, TriggerRule } from "../../core/trigger";

/** Maps a {@link TRIGGER_EVENTS} value to its PAC `on-event` / CEL `event` name. */
const PAC_EVENT: Record<TRIGGER_EVENTS, string> = {
    [TRIGGER_EVENTS.PUSH]: "push",
    [TRIGGER_EVENTS.PULL_REQUEST]: "pull_request",
    [TRIGGER_EVENTS.TAG]: "push", // tags arrive as push events; distinguished by ref
};

const PAC = "pipelinesascode.tekton.dev";

/** PAC bracket-list format, e.g. `[push, pull_request]`. */
const list = (xs: string[]): string => `[${xs.join(", ")}]`;

/** The ref prefix PAC reports as `target_branch` for a tag push. */
const TAG_REF = "refs/tags/";

/** A `branch` glob as a TAG rule means it: the tag name under `refs/tags/`. */
const tagRef = (g: string): string => (g.startsWith(TAG_REF) ? g : TAG_REF + g);

/**
 * Whether a rule fires on branch pushes but not tag pushes, and its branch filter could match a
 * tag ref. PAC delivers both as `push` events, and a glob such as the default `*` matches
 * `refs/tags/v1.0` too, so discrete annotations cannot keep tags out: only CEL can.
 */
function pushNeedsTagExclusion(r: TriggerRule): boolean {
    const on = toList(r.on);
    if (!on.includes(TRIGGER_EVENTS.PUSH) || on.includes(TRIGGER_EVENTS.TAG)) return false;
    return r.branch === undefined || toList(r.branch).some((g) => /[*?]/.test(g));
}

/** Whether a rule fires on TAG and on some other event too. */
function mixesTag(r: TriggerRule): boolean {
    const on = toList(r.on);
    return on.includes(TRIGGER_EVENTS.TAG) && on.length > 1;
}

/**
 * Whether the trigger requires the CEL path: multiple rules, a source-branch, raw cel, a
 * branch push that has to exclude tag pushes, or a rule mixing TAG with another event (the
 * discrete annotations have one target-branch list, which cannot hold a tag ref and a branch).
 */
function needsCel(t: PipelineTrigger): boolean {
    return (
        !!t.cel ||
        t.rules.length > 1 ||
        t.rules.some((r) => r.sourceBranch !== undefined || r.cel !== undefined || pushNeedsTagExclusion(r) || mixesTag(r))
    );
}

/**
 * The CEL clause for a rule's events. PUSH and TAG both arrive as `push` and are told apart
 * by the ref, so each keeps to its own: PUSH never fires on a tag, and TAG never on a branch.
 */
function eventClause(on: TRIGGER_EVENTS[]): string {
    const push = on.includes(TRIGGER_EVENTS.PUSH);
    const tag = on.includes(TRIGGER_EVENTS.TAG);
    const parts: string[] = [];
    if (push && tag) parts.push("event == 'push'");
    else if (push) parts.push(`(event == 'push' && !target_branch.startsWith('${TAG_REF}'))`);
    else if (tag) parts.push(`(event == 'push' && target_branch.startsWith('${TAG_REF}'))`);
    if (on.includes(TRIGGER_EVENTS.PULL_REQUEST)) parts.push("event == 'pull_request'");
    return parts.length === 1 ? parts[0] : `(${parts.join(" || ")})`;
}

/** Compiles one rule to a CEL boolean (its fields AND-ed). */
function ruleToCel(r: TriggerRule): string {
    const clauses: string[] = [eventClause(toList(r.on))];
    const branchClause = (field: "target_branch" | "source_branch", globs: string[]): string => {
        const parts = globs.map((g) =>
            /[*?]/.test(g) ? `${field}.matches('${globToRegex(g)}')` : `${field} == '${g}'`,
        );
        return parts.length === 1 ? parts[0] : `(${parts.join(" || ")})`;
    };
    if (r.branch !== undefined) {
        // A tag arrives with target_branch refs/tags/<name>, so a TAG rule's globs match under
        // that prefix; a rule that also fires on branches keeps the bare glob beside it.
        const globs = toList(r.branch);
        const on = toList(r.on);
        const targets = !on.includes(TRIGGER_EVENTS.TAG)
            ? globs
            : on.length === 1
              ? globs.map(tagRef)
              : globs.flatMap((g) => [g, tagRef(g)]);
        clauses.push(branchClause("target_branch", targets));
    }
    if (r.sourceBranch !== undefined) clauses.push(branchClause("source_branch", toList(r.sourceBranch)));
    if (r.pathsChanged?.length) {
        const any = r.pathsChanged
            .map((g) => `files.all.exists(f, f.matches('${globToRegex(g)}'))`)
            .join(" || ");
        clauses.push(r.pathsChanged.length === 1 ? any : `(${any})`);
    }
    if (r.pathsIgnored?.length) {
        // Match unless every changed file is ignored (i.e. only ignored paths changed).
        const ignored = r.pathsIgnored.map((g) => `f.matches('${globToRegex(g)}')`).join(" || ");
        clauses.push(`!files.all.all(f, ${ignored})`);
    }
    if (r.cel) clauses.push(`(${r.cel})`);
    return clauses.length === 1 ? clauses[0] : `(${clauses.join(" && ")})`;
}

/** Builds the PAC matching annotations for a trigger. */
export function triggerAnnotations(t: PipelineTrigger): Record<string, string> {
    const ann: Record<string, string> = {};

    if (needsCel(t)) {
        ann[`${PAC}/on-cel-expression`] = t.cel ?? t.rules.map(ruleToCel).join(" || ");
    } else {
        // Single rule, no source-branch, no raw cel → discrete annotations.
        const r = t.rules[0];
        const events = [...new Set(toList(r.on).map((e) => PAC_EVENT[e]))];
        ann[`${PAC}/on-event`] = list(events);
        const isTag = toList(r.on).includes(TRIGGER_EVENTS.TAG);
        ann[`${PAC}/on-target-branch`] = isTag
            ? list(r.branch !== undefined ? toList(r.branch).map(tagRef) : [`${TAG_REF}*`])
            : list(r.branch !== undefined ? toList(r.branch) : ["*"]);
        if (r.pathsChanged?.length) ann[`${PAC}/on-path-changed`] = list(r.pathsChanged);
        if (r.pathsIgnored?.length) ann[`${PAC}/on-path-change-ignore`] = list(r.pathsIgnored);
    }

    if (t.comment) ann[`${PAC}/on-comment`] = t.comment;
    if (t.labels?.length) ann[`${PAC}/on-label`] = list(t.labels);
    if (t.cancelInProgress) ann[`${PAC}/cancel-in-progress`] = "true";
    return ann;
}

/** The PAC annotation prefix, for targets and tests that build annotation keys. */
export { PAC as PAC_ANNOTATION_PREFIX };
