import { scriptLabel, type ScriptLanguage, type ScriptCtx } from './types';

/**
 * POSIX `sh` scripting language plugin (the portable default for Alpine/BusyBox
 * and Wolfi images that ship `/bin/sh` but not bash).
 *
 * The preamble provides a `log` helper. When {@link ScriptCtx.captureExitCode}
 * is set, the user body runs inside a subshell `( … )` so a mid-script `exit N`
 * is contained. The contract file keeps the *worst* exit code seen across a
 * task's steps (so a later success cannot mask an earlier failure); the step
 * then re-exits with its own code. All constructs are POSIX-clean, so
 * {@link Bash} reuses this implementation verbatim with a bash shebang.
 */
export class Sh implements ScriptLanguage {
  readonly name: string = 'sh';
  readonly shebang: string = '#!/bin/sh';

  protected preamble(): string {
    return [
      this.shebang,
      `log() { printf '[%s] %s\\n' "$(date +%H:%M:%S)" "$*"; }`,
    ].join('\n');
  }

  wrap(body: string, ctx: ScriptCtx): string {
    if (!ctx.captureExitCode) {
      return `${this.preamble()}\n${body}`;
    }
    return [
      this.preamble(),
      // The contract file is shared by every step in the pod, but each step may run
      // as a different uid (a step with its own securityContext.runAsUser — e.g. a
      // rootless buildkit image at uid 1000 — alongside steps at the pod default).
      // Whoever creates the file first owns it at the default 0644, which leaves it
      // read-only for the others, so their exit codes were silently dropped and the
      // reporter read a stale 0. Seed it with a real 0 (an empty file would break
      // the numeric comparison below) and open it up. Both lines are best-effort:
      // a later step that is not the owner cannot chmod, and by then need not.
      `[ -e ${ctx.exitCodePath} ] || printf '%s' 0 > ${ctx.exitCodePath}`,
      `chmod 0666 ${ctx.exitCodePath} 2>/dev/null || true`,
      ...this.runBody(body, ctx),
      // Attribute the failure. On a report-only task (a reporter with failOnError:false)
      // the log is the entire signal, and `sh` reports nothing of its own when the body
      // exits non-zero — see ScriptCtx.taskName.
      `if [ "$__tek_rc" -ne 0 ]; then log "error${scriptLabel(ctx)}: exited with status $__tek_rc"; fi`,
      `__tek_prev=$(cat ${ctx.exitCodePath} 2>/dev/null || echo 0)`,
      'if [ "$__tek_rc" -gt "$__tek_prev" ]; then __tek_prev="$__tek_rc"; fi',
      `printf '%s' "$__tek_prev" > ${ctx.exitCodePath}`,
      'exit "$__tek_rc"',
    ].join('\n');
  }

  /**
   * Runs the body in a subshell and leaves its exit code in `__tek_rc`.
   *
   * With {@link ScriptCtx.outputCapture} the body becomes a subshell function
   * (`f() ( … )`, so `exit` is still contained) whose combined output is piped
   * through `tee` to the capture file, then trimmed to its last `maxBytes`. A
   * pipeline's status is its last command's, and POSIX sh has no `pipefail`, so
   * the body's code comes back on fd 4 while the output reaches the log on fd 3.
   * An image without `tee` runs the body uncaptured rather than losing its log.
   */
  private runBody(body: string, ctx: ScriptCtx): string[] {
    const cap = ctx.outputCapture;
    if (!cap) return ['(', body, ')', '__tek_rc=$?'];
    const out = cap.path;
    return [
      '__tek_body() (',
      body,
      ')',
      'if command -v tee >/dev/null 2>&1; then',
      `  : > ${out} 2>/dev/null; chmod 0666 ${out} 2>/dev/null || true`,
      '  exec 3>&1',
      `  __tek_rc=$( { { __tek_body 3>&- 4>&- 2>&1; echo $? >&4; } | tee ${out} >&3; } 4>&1 )`,
      '  exec 3>&-',
      `  if [ "$(wc -c < ${out} 2>/dev/null || echo 0)" -gt ${cap.maxBytes} ]; then`,
      `    tail -c ${cap.maxBytes} ${out} > ${out}.tmp && cat ${out}.tmp > ${out}; rm -f ${out}.tmp`,
      '  fi',
      'else',
      '  __tek_body',
      '  __tek_rc=$?',
      'fi',
    ];
  }

  lintCommand(file: string): string[] {
    // shellcheck infers the sh/bash dialect from the shebang.
    return ['shellcheck', file];
  }
}
