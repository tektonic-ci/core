import { describe, it, expect } from 'vitest';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Sh } from './sh';
import { Bash } from './bash';
import { Nushell } from './nushell';
import { Python } from './python';
import { EXIT_CODE_PATH } from './types';
import type { ScriptLanguage } from './types';

/**
 * Pattern for unit-testing a script in isolation: render a body through its
 * language wrapper, execute it with the real interpreter, and assert both the
 * process exit code and the captured exit-code contract file. Each case is
 * skipped when its interpreter is unavailable so the suite stays hermetic.
 */
const has = (bin: string): boolean => {
  const r = spawnSync(bin, ['--version'], { stdio: 'ignore' });
  return !r.error;
};

/** Runs a captured wrapper and returns the process exit code + contract value. */
function runWrapped(lang: ScriptLanguage, interp: string, ext: string, body: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tek-rt-'));
  const ecPath = path.join(dir, 'exit-code');
  const file = path.join(dir, `step.${ext}`);
  // Render against a writable contract path inside the temp dir.
  fs.writeFileSync(file, lang.wrap(body, { exitCodePath: ecPath, captureExitCode: true }));
  const r = spawnSync(interp, [file], { encoding: 'utf8' });
  const contract = fs.existsSync(ecPath) ? fs.readFileSync(ecPath, 'utf8').trim() : '<none>';
  fs.rmSync(dir, { recursive: true, force: true });
  return { status: r.status, contract };
}

describe('script runtime contract', () => {
  it.skipIf(!has('sh'))('sh captures a failing exit code', () => {
    const r = runWrapped(new Sh(), 'sh', 'sh', 'echo hi\nexit 3');
    expect(r.status).toBe(3);
    expect(r.contract).toBe('3');
  });

  it.skipIf(!has('bash'))('bash captures a failing exit code', () => {
    const r = runWrapped(new Bash(), 'bash', 'bash', 'echo hi\nexit 3');
    expect(r.status).toBe(3);
    expect(r.contract).toBe('3');
  });

  it.skipIf(!has('nu'))('nushell maps a raised error to exit code 1', () => {
    const r = runWrapped(new Nushell(), 'nu', 'nu', 'print hi\nerror make {msg: "boom"}');
    expect(r.status).toBe(1);
    expect(r.contract).toBe('1');
  });

  it.skipIf(!has('python3'))('python captures sys.exit', () => {
    const r = runWrapped(new Python(), 'python3', 'py', 'log("hi")\nsys.exit(3)');
    expect(r.status).toBe(3);
    expect(r.contract).toBe('3');
  });

  it('uses the canonical contract path constant', () => {
    expect(EXIT_CODE_PATH).toBe('/tekton/home/.exit-code');
  });
});

/** Runs a wrapper with output capture and returns exit code, log, contract and capture. */
function runCaptured(
  lang: ScriptLanguage,
  interp: string,
  ext: string,
  body: string,
  maxBytes = 4096,
  allowExit = false,
) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tek-out-'));
  const ecPath = path.join(dir, 'exit-code');
  const outPath = path.join(dir, 'step-output');
  const file = path.join(dir, `step.${ext}`);
  fs.writeFileSync(
    file,
    lang.wrap(body, {
      exitCodePath: ecPath,
      captureExitCode: true,
      outputCapture: { path: outPath, maxBytes },
      allowExit,
    }),
  );
  const r = spawnSync(interp, [file], { encoding: 'utf8' });
  const read = (p: string) => (fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '<none>');
  const result = {
    status: r.status,
    log: `${r.stdout}${r.stderr}`,
    contract: read(ecPath).trim(),
    output: read(outPath),
    mode: fs.existsSync(outPath) ? fs.statSync(outPath).mode & 0o777 : 0,
  };
  fs.rmSync(dir, { recursive: true, force: true });
  return result;
}

// Each body writes to stdout and stderr from the interpreter itself and from an
// external command, then fails — the reporter needs all four, and the step must
// keep its exit code.
const outputCases: Array<[string, () => ScriptLanguage, string, string, string]> = [
  ['sh', () => new Sh(), 'sh', 'sh', 'echo own-out\necho own-err >&2\nsh -c "echo ext-out; echo ext-err >&2"\nexit 3'],
  ['bash', () => new Bash(), 'bash', 'bash', 'echo own-out\necho own-err >&2\nsh -c "echo ext-out; echo ext-err >&2"\nexit 3'],
  ['nu', () => new Nushell(), 'nu', 'nu', 'print own-out\nprint -e own-err\n^sh -c "echo ext-out; echo ext-err >&2"\nerror make {msg: "boom"}'],
  ['python3', () => new Python(), 'python3', 'py', 'print("own-out")\nprint("own-err", file=sys.stderr)\nimport subprocess\nsubprocess.run(["sh", "-c", "echo ext-out; echo ext-err >&2"])\nsys.exit(3)'],
];

describe('step output capture', () => {
  for (const [bin, make, interp, ext, body] of outputCases) {
    it.skipIf(!has(bin))(`${bin} tees combined output to the capture file and keeps the exit code`, () => {
      const r = runCaptured(make(), interp, ext, body);
      const code = bin === 'nu' ? 1 : 3;
      expect(r.status).toBe(code);
      expect(r.contract).toBe(String(code));
      for (const line of ['own-out', 'own-err', 'ext-out', 'ext-err']) {
        expect(r.output).toContain(line);
        expect(r.log).toContain(line);
      }
      expect(r.mode).toBe(0o666);
    });
  }

  const longBodies: Array<[string, () => ScriptLanguage, string, string, string]> = [
    ['sh', () => new Sh(), 'sh', 'sh', 'i=0; while [ $i -lt 200 ]; do echo "line-$i"; i=$((i+1)); done'],
    ['nu', () => new Nushell(), 'nu', 'nu', '0..199 | each { |i| print $"line-($i)" } | ignore'],
    ['python3', () => new Python(), 'python3', 'py', 'for i in range(200): print(f"line-{i}")'],
  ];
  for (const [bin, make, interp, ext, body] of longBodies) {
    it.skipIf(!has(bin))(`${bin} keeps only the last maxBytes`, () => {
      const r = runCaptured(make(), interp, ext, body, 64);
      expect(r.status).toBe(0);
      expect(Buffer.byteLength(r.output)).toBe(64);
      expect(r.output.endsWith('line-199\n')).toBe(true);
      expect(r.log).toContain('line-0\n');
    });
  }

  it.skipIf(!has('nu'))('nu reports a deliberate non-zero exit through the capture', () => {
    const r = runCaptured(new Nushell(), 'nu', 'nu', 'print bye\nexit 5', 4096, true);
    expect(r.status).toBe(5);
    expect(r.output).toContain('bye');
  });

  it.skipIf(!has('sh'))('sh contains a body exit inside the capture', () => {
    const r = runCaptured(new Sh(), 'sh', 'sh', 'echo first\nexit 0\necho never');
    expect(r.status).toBe(0);
    expect(r.output).toBe('first\n');
  });
});
