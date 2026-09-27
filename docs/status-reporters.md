# Status Reporters

A `StatusReporter` posts a pipeline's per-task outcome to some external system — GitHub
commit statuses, a Slack channel, a dashboard. Attach one to a task and tektonic wires the
rest: a pending task that runs first, a reporting step appended to the task, and a `finally`
task that reconciles anything left pending.

| Reporter | Package |
|---|---|
| GitHub Commit Status API | [`@tektonic-ci/reporter-github`](https://github.com/tektonic-ci/reporter-github) |

There is no built-in reporter in `@tektonic-ci/core`, on purpose. `StatusReporter` is a
strategy interface, and the GitHub implementation lives outside core so the interface is
exercised by a real out-of-tree consumer instead of by code that could quietly reach into
internals. It lives in its own repo, [tektonic-ci/reporter-github](https://github.com/tektonic-ci/reporter-github), and builds against
core from npm, so anything you would need and cannot reach breaks there first. It is also
the reference implementation to start from when writing your own reporter.

## The interface

```ts
import type { StatusReporter } from '@tektonic-ci/core';

interface StatusReporter {
  readonly requiredParams: Param[];
  createPendingTask(contexts: string[], name?: string): Task;
  finalStep(context: string, userStepNames?: string[]): TaskStepSpec;
  createStatusReconcilerTask?(entries: { taskName: string; context: string }[], name?: string): Task;
  /** @deprecated — implement createStatusReconcilerTask instead. */
  createSkipResolverTask?(entries: { taskName: string; context: string }[], name?: string): Task;
  pendingGroupKey?(): string;
}
```

Three of the six members are optional, and which one a pipeline calls is feature-detected, so
the full method set is worth spelling out.

### `requiredParams`

Params every reporting task needs — the GitHub reporter asks for `repo-full-name` and
`revision`. `Task` merges these into its own `params` automatically, and a param the user
declared with the same name wins, so a caller can retype or re-describe one.

### `createPendingTask(contexts, name)`

Returns a `Task` that sets every context to "pending". `Pipeline` emits it once per reporter
*group* (see [`pendingGroupKey`](#pendinggroupkey)) and makes every task in that group
`runAfter` it. Two groups in one pipeline (two different systems, or the same one configured
differently) each get their own, suffixed `-2`, `-3`, … — so key any per-instance state on
`this`, not on a module global.

One step can post every context — the GitHub reporter loops over them in a single container.
If it does, try every context before failing, so one failed POST does not leave the rest
unset.

`name` is supplied by the pipeline, scoped as `set-status-pending-<pipeline>`. Honour it: a
project emitting several pipelines writes one manifest per unique task name, and a reporter
that ignores the argument makes two pipelines collide on one file.

### `finalStep(context, userStepNames)`

The step appended as the **last** step of each reporting task. It reports success or failure
for that one context.

Read the outcome from two places, because neither alone is complete:

- **`EXIT_CODE_PATH`** — the contract file. When a task has a reporter, `TaskDef.synth`
  wraps every preceding user step so it captures its own exit code here and carries
  `onError: 'continue'`, letting the pipeline reach this step at all. A body that calls the
  shell's `exit` directly bypasses the wrapper, which is why…
- **`stepExitCodePath(stepName)`** — Tekton's own per-step exit code, written by the
  entrypoint whatever the body did. `userStepNames` lists the task's user steps in order so
  you can consult these too.

Injected cache restore/save steps are deliberately **not** in `userStepNames`: they carry
`onError: 'continue'` of their own, and a failed cache save must not fail the task.

Whether the step re-exits that code — turning a red status into a failed `TaskRun` — is the
reporter's choice. The GitHub reporter does by default and takes `failOnError: false` to opt
out.

### `createStatusReconcilerTask(entries, name)`

Optional, and the reason it exists is worth knowing before you skip it. A task's own
`finalStep` is its last step, so anything stopping the task from reaching it leaves the
context pending **forever**: a `when` that skips the task, but equally an OOMKill, a node
eviction, an image-pull failure or a `TaskRun` timeout, none of which run any step at all.

Return a `Task` for the pipeline's `finally` block that checks each entry's settled task
status:

- `None` — skipped by `when`, directly or because an ancestor was skipped or failed.
- `Failed` — failed, including the infrastructure kills above.

Anything else ran to completion and reported itself; no-op for it. Re-posting a red status
for a `Failed` task that *did* report is idempotent, so err on the side of posting.

**The status must arrive as a param, not as `$(tasks.<name>.status)` written into the script.**
Tekton substitutes `$(tasks.*)` in a PipelineTask's `params` and `when`, but *not* inside a
referenced Task's step script, where it stays a literal string — so the comparison never
matches and every step silently exits 0. Use `Param.pipelineExpression` to have the finally
PipelineTask supply the real value:

```ts
new Param({
  name: `status-${taskName}`,        // task names are valid k8s names; contexts may contain '/'
  type: 'string',
  pipelineExpression: `$(tasks.${taskName}.status)`,
});
```

A param carrying a `pipelineExpression` is bound by the PipelineTask and excluded from the
pipeline's own inferred params, so it never reaches the PipelineRun's interface.

Don't let one failed POST swallow the rest. Tekton skips every remaining step in a pod once
one exits non-zero, so with a step per entry give each `onError: 'continue'`; with a single
step (as the GitHub reporter does), try every entry and exit non-zero once at the end.

`createSkipResolverTask` is the deprecated predecessor, covering only skipped tasks.
`Pipeline` prefers `createStatusReconcilerTask` and falls back to it, so an older reporter
keeps working; implement the newer one. Implement neither and pipelines simply skip
reconciliation.

### `pendingGroupKey()`

Optional. Lets reporters share one pending task and one reconciler task. `Pipeline` merges
reporters of the same class whose keys are equal into one group, built by whichever it
discovers first; without a key, every instance is its own group.

Put in the key everything `createPendingTask` and `createStatusReconcilerTask` depend on, and
nothing that only shapes `finalStep` — each task still takes its final step from its own
reporter. The GitHub reporter's key leaves out `failOnError`, so a strict and a report-only
instance share one pending task instead of emitting a `-2` copy.

## Checking an implementation

`assertStatusReporterConformance` from `@tektonic-ci/core/testing` drives a reporter through
core's synthesis and checks every contract above. Run it in your package's tests, and against
`@tektonic-ci/core@next` to hear about a break before it's released. See
[testing.md](testing.md#testing-a-provider-the-conformance-kit).

## Images

Reporter steps are injected steps, so they resolve their image the same way cache steps do:
the step's own image → the reporter's own default → the project's `injectedStepImage`. Ask
for what your steps actually invoke with `injectedImageRef(...)` rather than hardcoding an
image, and a project whose image lacks it is told at synth time:

```ts
this.image = opts.image ?? injectedImageRef('nushell');   // GitHub reporter: nushell `http post`
```

See [docs/cache-backends.md](cache-backends.md#image-resolution) for the full order.

## Using one

```ts
import { Task } from '@tektonic-ci/core';
import { GitHubStatusReporter } from '@tektonic-ci/reporter-github';

const statusReporter = new GitHubStatusReporter({ skipTokenInjection: true });

new Task({
  name: 'test',
  statusContext: 'ci/test',   // the external check name; defaults to the task name
  statusReporter,
  steps: [/* … */],
});
```
