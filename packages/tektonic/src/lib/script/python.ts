import type { ScriptLanguage, ScriptCtx } from './types';

/** Indents every non-blank line by one level (4 spaces); blank lines stay blank. */
function indent(body: string): string {
  return body
    .split('\n')
    .map((line) => (line.trim().length ? `    ${line}` : line))
    .join('\n');
}

/**
 * With {@link ScriptCtx.outputCapture}, points fds 1 and 2 at a pipe whose reader
 * thread copies everything to the original stdout and to the capture file. Doing it
 * at the descriptor level, not by swapping `sys.stdout`, catches the output of the
 * subprocesses a body runs as well as its own. Any failure to set it up leaves the
 * step running uncaptured.
 */
function captureStart(ctx: ScriptCtx): string[] {
  const cap = ctx.outputCapture;
  if (!cap) return [];
  return [
    '_tek_cap = None',
    'try:',
    '    import threading as _tek_th',
    `    _tek_f = open("${cap.path}", "wb")`,
    '    try:',
    `        _tek_os.chmod("${cap.path}", 0o666)`,
    '    except OSError:',
    '        pass',
    '    _tek_r, _tek_w = _tek_os.pipe()',
    '    _tek_o1, _tek_o2 = _tek_os.dup(1), _tek_os.dup(2)',
    '    def _tek_pump():',
    '        while True:',
    '            _b = _tek_os.read(_tek_r, 65536)',
    '            if not _b:',
    '                break',
    '            _v = memoryview(_b)',
    '            while _v:',
    '                _v = _v[_tek_os.write(_tek_o1, _v):]',
    '            _tek_f.write(_b)',
    '    _tek_t = _tek_th.Thread(target=_tek_pump, daemon=True)',
    '    _tek_t.start()',
    '    sys.stdout.flush(); sys.stderr.flush()',
    '    _tek_os.dup2(_tek_w, 1); _tek_os.dup2(_tek_w, 2); _tek_os.close(_tek_w)',
    '    _tek_cap = (_tek_t, _tek_f, _tek_o1, _tek_o2)',
    'except Exception:',
    '    pass',
  ];
}

/**
 * Restores fds 1 and 2, drains the pipe and trims the capture file to its last
 * `maxBytes`. The join is bounded: a background process the body left running
 * still holds the pipe open, and must not hold the step with it.
 */
function captureEnd(ctx: ScriptCtx): string[] {
  const cap = ctx.outputCapture;
  if (!cap) return [];
  return [
    'if _tek_cap:',
    '    try:',
    '        sys.stdout.flush(); sys.stderr.flush()',
    '    except Exception:',
    '        pass',
    '    _tek_os.dup2(_tek_cap[2], 1); _tek_os.dup2(_tek_cap[3], 2)',
    '    _tek_cap[0].join(5)',
    '    try:',
    '        _tek_cap[1].close()',
    `        with open("${cap.path}", "rb") as _f: _tek_b = _f.read()`,
    `        if len(_tek_b) > ${cap.maxBytes}:`,
    `            with open("${cap.path}", "wb") as _f: _f.write(_tek_b[-${cap.maxBytes}:])`,
    '    except Exception:',
    '        pass',
  ];
}

/**
 * Python scripting language plugin.
 *
 * The preamble provides a `log` helper. When capturing, the body is placed
 * inside `def _tek_main()` (re-indented one level) so `sys.exit(N)` raises
 * `SystemExit`, which the wrapper catches and maps to an exit code; any other
 * uncaught exception maps to `1` after printing a traceback. The contract file
 * keeps the *worst* code seen across a task's steps (a later success cannot mask
 * an earlier failure); the step re-exits its own. Bodies just `sys.exit(N)`.
 */
export class Python implements ScriptLanguage {
  readonly name = 'python';
  readonly shebang = '#!/usr/bin/env python3';

  private preamble(): string {
    return [
      this.shebang,
      'import sys',
      'from datetime import datetime as _dt',
      'def log(_m): print(f"[{_dt.now():%H:%M:%S}] {_m}", flush=True)',
    ].join('\n');
  }

  wrap(body: string, ctx: ScriptCtx): string {
    if (!ctx.captureExitCode) {
      return `${this.preamble()}\n${body}`;
    }
    const indented = indent(body).replace(/\s+$/, '');
    const mainBody = indented.trim().length ? indented : '    pass';
    return [
      this.preamble(),
      // See Sh.wrap: the contract file is shared across steps that may run as
      // different uids, so seed it and make it group/other-writable before the
      // body. Best-effort — a non-owner's chmod raises, and by then need not run.
      'import os as _tek_os',
      'try:',
      `    if not _tek_os.path.exists("${ctx.exitCodePath}"):`,
      `        with open("${ctx.exitCodePath}", "w") as _f: _f.write("0")`,
      `    _tek_os.chmod("${ctx.exitCodePath}", 0o666)`,
      'except OSError:',
      '    pass',
      'def _tek_main():',
      mainBody,
      ...captureStart(ctx),
      '_tek_rc = 0',
      'try:',
      '    _tek_main()',
      'except SystemExit as _e:',
      '    _tek_rc = _e.code if isinstance(_e.code, int) else (0 if _e.code is None else 1)',
      'except BaseException:',
      '    import traceback; traceback.print_exc(); _tek_rc = 1',
      ...captureEnd(ctx),
      'try:',
      `    with open("${ctx.exitCodePath}") as _f: _tek_prev = int(_f.read().strip() or 0)`,
      'except Exception:',
      '    _tek_prev = 0',
      `with open("${ctx.exitCodePath}", "w") as _f:`,
      '    _f.write(str(max(_tek_prev, _tek_rc)))',
      'sys.exit(_tek_rc)',
    ].join('\n');
  }

  lintCommand(file: string): string[] {
    return ['python3', '-m', 'py_compile', file];
  }
}
