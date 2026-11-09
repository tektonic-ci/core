import { scriptLabel, type ScriptLanguage, type ScriptCtx } from './types';

/** Set on the child a capturing wrapper re-runs itself as; see {@link Nushell.captureOutput}. */
const CAPTURED_ENV = 'TEKTONIC_OUTPUT_CAPTURED';

/**
 * Nushell scripting language plugin.
 *
 * The preamble provides the `log` helper previously copy-pasted as `nuHeader`
 * in consumers. Nushell's `exit` terminates the process immediately and cannot
 * be trapped, so the captured-exit contract runs the body inside `def main []`
 * wrapped in `try/catch`: clean completion yields `0`, a raised nushell error
 * yields `1`. Bodies should still signal failure by raising (`error make`) or
 * by letting an external command fail, since that is what produces a readable
 * message — but `exit` is no longer a trap: the reporter also reads Tekton's
 * own per-step exit code, which is recorded by the entrypoint and so survives a
 * body that terminates before this wrapper runs. The contract file keeps the
 * *worst* code seen across a task's steps (a later success cannot mask an
 * earlier failure); the step re-exits its own.
 */
export class Nushell implements ScriptLanguage {
  readonly name = 'nushell';
  readonly shebang = '#!/usr/bin/env nu';

  private preamble(): string {
    return [
      this.shebang,
      `def log [msg: string] { print $"[(date now | format date '%H:%M:%S')] ($msg)" }`,
    ].join('\n');
  }

  /**
   * Fails synthesis on a non-zero `exit` in a capturing body.
   *
   * nushell's `exit` cannot be trapped, so the process dies before the wrapper
   * below persists anything: the contract file keeps its seeded `0`, and the
   * failure survives only because the reporter also reads Tekton's per-step
   * exit code — with no `error [task/step]` line to say what failed. This was a
   * silent-green bug in a consumer's own drift check for months, which is why a
   * warning is not enough for it. `error make {msg: "..."}` keeps both the
   * failure and its message.
   *
   * `exit 0` is exempt: an early return from a body with nothing to do is a
   * legitimate and common shape, and it cannot hide a failure. A body that
   * genuinely must exit non-zero opts out with {@link unsafeAllowExit}.
   */
  private errorOnExit(body: string, ctx: ScriptCtx): void {
    const scannable = body
      // Raw strings carry scripts for *other* interpreters — ocidex's
      // go-vulncheck watchdog embeds a POSIX sh body whose `exit 99` is correct.
      .replace(/r(#+)'[\s\S]*?'\1/g, '')
      .replace(/^\s*#.*$/gm, '');
    for (const [, arg] of scannable.matchAll(/(?:^|[;(|{\s])exit\s+(\S+)/g)) {
      if (arg === '0') continue;
      throw new Error(
        `tektonic${scriptLabel(ctx)}: nushell 'exit ${arg}' terminates before the wrapper can ` +
          `record what failed, leaving the exit-code contract on its seeded 0. Raise instead ` +
          `— error make {msg: "..."} — or wrap the body in unsafeAllowExit() if the exit is ` +
          `deliberate.`,
      );
    }
  }

  wrap(body: string, ctx: ScriptCtx): string {
    if (!ctx.captureExitCode) {
      return `${this.preamble()}\n${body}`;
    }
    if (!ctx.allowExit) this.errorOnExit(body, ctx);
    return [
      this.preamble(),
      // See Sh.wrap: the contract file is shared across steps that may run as
      // different uids, so seed it and make it group/other-writable before the
      // body. Both statements are best-effort — a non-owner's chmod fails, and
      // by then the owner has already opened the file up.
      `if not ("${ctx.exitCodePath}" | path exists) { try { "0" | save -f ${ctx.exitCodePath} } }`,
      `try { ^chmod 0666 ${ctx.exitCodePath} }`,
      'def main [] {',
      body,
      '}',
      ...this.captureOutput(ctx),
      // Attribute the failure. nushell's message for a failed external command is the
      // generic "External command had a non-zero exit code", which on a report-only task
      // is the entire signal — see ScriptCtx.taskName. Task and step names are Kubernetes
      // names (alphanumeric + dash), so they cannot introduce the bare parentheses that
      // nushell would evaluate inside an interpolated string.
      `let __tek_rc = (try { main; 0 } catch { |e| print $"error${scriptLabel(ctx)}: ($e.msg)"; 1 })`,
      `let __tek_prev = (try { open --raw ${ctx.exitCodePath} | str trim | into int } catch { 0 })`,
      'let __tek_worst = ([$__tek_prev $__tek_rc] | math max)',
      `$"($__tek_worst)" | save -f ${ctx.exitCodePath}`,
      'exit $__tek_rc',
    ].join('\n');
  }

  /**
   * With {@link ScriptCtx.outputCapture}, the script re-runs itself as a child and
   * tees the child's combined output to the log and the capture file.
   *
   * The body runs in this process, so its `print`s and its external commands write
   * straight to the step's stdout — nothing in-process can intercept them. Running
   * the same file again under `TEKTONIC_OUTPUT_CAPTURED` (which skips this block)
   * puts all of it on one stream. `complete` is the only sink that keeps the child's
   * exit code — through `print` or `save` it reads as 0 — and it holds the output
   * in memory until the child exits; a body that exits non-zero on purpose still
   * reports its own code, since it is the child's.
   */
  private captureOutput(ctx: ScriptCtx): string[] {
    const cap = ctx.outputCapture;
    if (!cap) return [];
    const out = cap.path;
    return [
      `if ($env.${CAPTURED_ENV}? | is-empty) {`,
      `  try { "" | save -f ${out} }`,
      `  try { ^chmod 0666 ${out} }`,
      `  let rc = (with-env {${CAPTURED_ENV}: "1"} { ^$nu.current-exe $env.CURRENT_FILE o+e>| tee { print -n -r } | tee { save -f ${out} } | complete | get exit_code })`,
      `  try {`,
      `    let b = (open --raw ${out} | into binary)`,
      `    if ($b | bytes length) > ${cap.maxBytes} { $b | bytes at (-${cap.maxBytes}).. | save -f ${out} }`,
      `  }`,
      '  exit $rc',
      '}',
    ];
  }

  lintCommand(file: string): string[] {
    // `nu-check` returns a validity boolean; wrap it so the process exit code
    // reflects pass/fail (unlike `nu --ide-check`, which always exits 0).
    return ['nu', '-c', `if (nu-check ${JSON.stringify(file)}) { exit 0 } else { exit 1 }`];
  }
}
