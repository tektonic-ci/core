import { Task } from './task';
import type { TaskStepSpec } from './task';
import { Param } from './param';

/**
 * Provider-agnostic interface for reporting pipeline task statuses to an external system.
 *
 * Implementations supply:
 * - A factory to create the pending task that runs first in the pipeline
 * - A step that reports the final status (success/failure) at the end of each task
 */
export interface StatusReporter {
  /**
   * Creates a Task that sets all given contexts to "pending".
   * This task should run before any other task in the pipeline.
   *
   * `name` lets the caller scope the task name per pipeline, so multi-pipeline
   * projects (e.g. TektonicProject emitting one file per unique task name) don't
   * collide on a single shared `set-status-pending` task.
   */
  createPendingTask(contexts: string[], name?: string): Task;

  /**
   * Returns a step that reports the final status of the given context.
   * The step reads the captured exit code from {@link EXIT_CODE_PATH} and
   * reports success or failure accordingly.
   *
   * `TaskDef.synth` appends this as the last step and, for every preceding user
   * step, automatically enables exit-code capture and sets `onError: 'continue'`
   * — so the user body just exits naturally; no manual contract-file writes are
   * needed.
   *
   * `userStepNames` lists the task's user steps in order, so an implementation
   * can also consult Tekton's own per-step exit codes (see `stepExitCodePath`)
   * instead of trusting only the in-script contract file, which a body calling
   * the shell's `exit` bypasses. The framework's injected cache restore/save
   * steps are deliberately excluded from the list: they carry
   * `onError: 'continue'` of their own, and a failed cache save must not fail
   * the task.
   *
   * Optional so existing external implementations of {@link StatusReporter}
   * keep compiling.
   */
  finalStep(context: string, userStepNames?: string[]): TaskStepSpec;

  /**
   * Returns a step that reports the given context as started — the task's pod is
   * scheduled and running, as opposed to the "pending" {@link createPendingTask} set while
   * it still waited on `runAfter` or a node.
   *
   * `TaskDef.synth` prepends this as the task's first step, ahead of the injected cache
   * restore steps, and always renders it with `onError: 'continue'`: a failed report must
   * never fail the task. It is not one of the user steps handed to {@link finalStep}.
   *
   * Optional: a reporter that does not implement it gets no start step, and its contexts
   * stay "pending" until {@link finalStep} reports the result.
   */
  startStep?(context: string): TaskStepSpec;

  /**
   * Returns a Task (for the pipeline's `finally` block) that reconciles any context left on
   * "pending" after the DAG settles. One step per entry, checking Tekton's
   * `$(tasks.<taskName>.status)`:
   *
   * - `None` — the task was skipped by `when` (directly, or because an ancestor was
   *   skipped or failed), so its own {@link finalStep} never ran.
   * - `Failed` — the task failed, possibly at the infrastructure level (OOMKill, node
   *   eviction, image-pull failure, TaskRun timeout), in which case {@link finalStep} never
   *   ran either and nothing else will take the context off "pending".
   *
   * A task that ran to completion normally reported itself via {@link finalStep}; the step
   * no-ops for it.
   *
   * Optional so existing external implementations of {@link StatusReporter} keep compiling —
   * pipelines simply skip reconciliation when a reporter implements neither this nor the
   * deprecated {@link createSkipResolverTask}.
   */
  createStatusReconcilerTask?(entries: { taskName: string; context: string }[], name?: string): Task;

  /**
   * @deprecated Implement {@link createStatusReconcilerTask} instead — it covers tasks
   * terminated by the infrastructure as well as skipped ones. Pipelines fall back to this
   * method when a reporter does not implement the newer one.
   */
  createSkipResolverTask?(entries: { taskName: string; context: string }[], name?: string): Task;

  /**
   * Identifies reporters that can share one pending task and one reconciler task. A pipeline
   * merges the tasks of reporters of the same class whose keys are equal into a single group,
   * built by whichever of them it discovers first.
   *
   * Include everything {@link createPendingTask} and {@link createStatusReconcilerTask}
   * depend on, and nothing that only affects {@link finalStep} — each task still gets its
   * final step from its own reporter.
   *
   * Optional: a reporter that does not implement it gets a group per instance.
   */
  pendingGroupKey?(): string;

  /** Parameters required by this reporter (e.g., repo name, revision). */
  readonly requiredParams: Param[];
}
