/**
 * Canonical path where a wrapped step writes its captured exit code.
 *
 * This is the single source of truth for the exit-code contract shared between
 * a task's work step and a {@link StatusReporter}'s final step: the work step
 * runs with `onError: 'continue'` and writes its exit code here, and the
 * reporter step reads it to decide success/failure. Centralizing the literal
 * here replaces the hand-written `/tekton/home/.exit-code` strings previously
 * scattered across the reporter and consumer scripts.
 */
export const EXIT_CODE_PATH = '/tekton/home/.exit-code' as const;

/**
 * Path at which Tekton records a step's own exit code, as a symlink into
 * `/tekton/run/<index>/status/exitCode`.
 *
 * This is Tekton's mechanism, not tektonic's, and it is authoritative where
 * {@link EXIT_CODE_PATH} is not: the contract file is written *by the wrapped
 * script*, so a body that calls the shell's `exit` — untrappable in nushell —
 * terminates before the wrapper can persist anything, leaving a stale `0` that
 * a reporter reads as success. Tekton writes this file from the entrypoint
 * binary instead, so it survives that.
 *
 * Verified against Tekton on a live cluster rather than taken from the docs:
 * the file is written for *every* completed step (not only failed ones) and
 * regardless of whether the step sets `onError`, at mode 0644 so a step running
 * as a different uid can still read it. It is absent only for the step
 * currently executing — which is the reporter's own position, so a reporter can
 * never read itself.
 */
export function stepExitCodePath(stepName: string): string {
  return `/tekton/steps/step-${stepName}/exitCode`;
}

/**
 * Default cap on a captured step-output file, in bytes: the last 64 KiB of the
 * step's combined stdout and stderr are kept. See {@link StepOutputCapture}.
 */
export const DEFAULT_STEP_OUTPUT_MAX_BYTES = 64 * 1024;

/**
 * Path at which a user step's captured output is left for a reporter to read,
 * when the task's {@link StatusReporter} opts in through `captureStepOutput`.
 *
 * The file holds the tail of the step's combined stdout and stderr, at most the
 * reporter's `maxBytes`. It lives under `/tekton/home`, which every step in the
 * pod shares, at mode 0666 so a reporter running as another uid can read it. It
 * is absent for a step that did not run, and for a step whose body terminated
 * the interpreter before the wrapper could write it — read it as best-effort and
 * keep {@link stepExitCodePath} as the authority on success.
 *
 * The output is the step's log as-is: anything a step prints, a secret included,
 * ends up here. A reporter that posts it somewhere public must say so.
 */
export function stepOutputPath(stepName: string): string {
  return `/tekton/home/.step-output-${stepName}`;
}

/** Where and how much of a step's output a capturing wrapper keeps. */
export interface OutputCapture {
  /** File the tail of the body's combined stdout and stderr is written to. */
  path: string;
  /** Bytes kept: the last `maxBytes` of the output. */
  maxBytes: number;
}

/**
 * ` [task/step]` for a wrapper's failure line, or `''` when the context carries
 * neither name. Shared so every language plugin labels failures identically.
 */
export function scriptLabel(ctx: Pick<ScriptCtx, 'taskName' | 'stepName'>): string {
  const parts = [ctx.taskName, ctx.stepName].filter(Boolean);
  return parts.length ? ` [${parts.join('/')}]` : '';
}

/**
 * Context passed to {@link ScriptLanguage.wrap} at synth time.
 *
 * Carries the framework concerns a language plugin must honour when wrapping a
 * user-authored body — chiefly the exit-code/status contract — so that the
 * plumbing lives in the library rather than being hand-written in every script.
 */
export interface ScriptCtx {
  /**
   * Absolute path the wrapper writes the captured exit code to.
   * Defaults to {@link EXIT_CODE_PATH}; injectable for testing.
   */
  exitCodePath: string;
  /**
   * When `true`, the wrapper must run the body, capture its exit code to
   * {@link ScriptCtx.exitCodePath}, and still exit with that code — so a
   * later status step can read it. Set when the task reports status.
   * When `false`, the body runs without exit-code capture.
   *
   * A capturing wrapper must also make {@link ScriptCtx.exitCodePath} writable
   * by every step in the pod before it uses it: steps can declare their own
   * `securityContext.runAsUser`, and a file created by the first step at the
   * default 0644 is read-only for a step running as a different uid, whose
   * exit code would then be dropped in silence.
   */
  captureExitCode: boolean;
  /**
   * Task and step this body belongs to, used to attribute the failure line a
   * capturing wrapper emits.
   *
   * Without them a failed external command reports only nushell's generic
   * "External command had a non-zero exit code" — no task, no step, no command.
   * For a report-only task (a reporter with `failOnError: false`) that line and
   * the check's colour are the *only* signal there is, so an anonymous one is
   * close to no signal at all.
   *
   * Optional: a body rendered outside a task (tests, the library's own injected
   * steps) simply gets the unlabelled form.
   */
  taskName?: string;
  stepName?: string;
  /**
   * Set by {@link unsafeAllowExit} on the body being rendered: the author has stated that a
   * non-zero `exit` in this body is deliberate, so a language whose `exit` bypasses the
   * capture wrapper (nushell) permits it instead of failing synthesis.
   */
  allowExit?: boolean;
  /**
   * When set, and {@link ScriptCtx.captureExitCode} is too, the wrapper also tees
   * the body's combined stdout and stderr to {@link OutputCapture.path}, keeping
   * the last {@link OutputCapture.maxBytes}. The output still reaches the step's
   * log as before. Ignored when not capturing the exit code. A language that does
   * not implement it leaves no file, which a reporter must tolerate anyway.
   */
  outputCapture?: OutputCapture;
}

/**
 * A pluggable scripting language for step bodies.
 *
 * Each implementation (bash, nushell, python, …) knows how to render a shebang,
 * wrap a user-authored body with the framework's exit-code/status contract and
 * a small helper preamble, and produce the dev-harness command that lints an
 * extracted script file. Languages are an internal abstraction of tektonic:
 * no language is mandated, and the helper preamble is generated here at synth
 * time rather than sourced from any external image module.
 */
export interface ScriptLanguage {
  /** Stable identifier, e.g. `'bash'`, `'nushell'`, `'python'`. */
  readonly name: string;
  /** Shebang line prepended to the rendered script (without trailing newline). */
  readonly shebang: string;
  /**
   * Wraps a user-authored body into a complete script: shebang + helper
   * preamble + the body, honouring the exit-code contract in {@link ScriptCtx}.
   */
  wrap(body: string, ctx: ScriptCtx): string;
  /**
   * Returns the argv used to syntax-check/lint an extracted script `file`
   * in the local dev harness (e.g. `['shellcheck', file]`).
   */
  lintCommand(file: string): string[];
}
