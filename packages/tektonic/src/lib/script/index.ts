import { Sh } from './sh';
import { Bash } from './bash';
import { Nushell } from './nushell';
import { Python } from './python';
import { scriptLabel, EXIT_CODE_PATH } from './types';
import type { ScriptLanguage, ScriptCtx } from './types';

export type { ScriptLanguage, ScriptCtx } from './types';
export { EXIT_CODE_PATH, stepExitCodePath, stepOutputPath, DEFAULT_STEP_OUTPUT_MAX_BYTES } from './types';
export type { OutputCapture } from './types';
export { embedSh } from './embed';
export type { EmbedShOptions } from './embed';
export { Sh } from './sh';
export { Bash } from './bash';
export { Nushell } from './nushell';
export { Python } from './python';

/** Names of the languages tektonic ships, kept as a union so they still autocomplete. */
export type KnownLanguageName = 'sh' | 'bash' | 'nushell' | 'python';

/**
 * The name of a registered script language.
 *
 * Widened to `string` so a language registered by another package is nameable wherever a
 * built-in is — `defaultLanguage`, the `{ language, body }` object form, `scriptFromFile`'s
 * override. The `string & {}` arm is what stops TypeScript collapsing the union to plain
 * `string`, so `'nushell'` still autocompletes and `'nushel'` still gets flagged by review
 * tooling even though an arbitrary name type-checks.
 */
export type LanguageName = KnownLanguageName | (string & {});

/** The tagged-template function {@link registerLanguage} hands back, e.g. `sh` or `nu`. */
export type ScriptTag = (strings: TemplateStringsArray, ...values: unknown[]) => Script;

/** Options for {@link registerLanguage}. */
export interface RegisterLanguageOptions {
  /**
   * File extensions this language claims, for {@link scriptFromFile} and `tektonic lint`.
   * A leading dot is optional and matching is case-insensitive (`'ts'` and `'.TS'` are the
   * same claim).
   */
  extensions?: string[];
}

interface Registration {
  language: ScriptLanguage;
  extensions: string[];
}

/** Registered languages, keyed by {@link ScriptLanguage.name}. */
const LANGUAGES = new Map<string, Registration>();
/** Claimed file extension (lower-case, dot-prefixed) → language name. */
const EXTENSIONS = new Map<string, string>();

function normalizeExtension(ext: string): string {
  const lower = ext.trim().toLowerCase();
  return lower.startsWith('.') ? lower : `.${lower}`;
}

/**
 * Registers a {@link ScriptLanguage} and returns its tagged-template helper.
 *
 * Registration and use are one step, so a language reaches every ergonomic the built-ins
 * have — the tag, `languageFor`, the `{ language, body }` object form, `defaultLanguage`,
 * `scriptFromFile` and `tektonic lint` — without the core knowing it exists:
 *
 * ```ts
 * export const deno = registerLanguage(new DenoLanguage(), { extensions: ['.ts'] });
 * // then: script: deno`console.log("hi")`
 * ```
 *
 * The returned tag keeps call sites type-safe without a stringly-typed name; the name is
 * still needed for the paths where a string genuinely is the input (a file extension, a
 * project-level `defaultLanguage`), and {@link languageFor} resolves those.
 *
 * One thing a language may not opt out of is the exit-code contract: a `wrap` that ignores
 * {@link ScriptCtx.captureExitCode} reports a failed step as green. Prove compliance with
 * `assertExitCodeContract` from `@tektonic-ci/core/testing`.
 *
 * @throws if the name is empty, or already registered — silently overriding a language
 * would change every body that uses it, at a distance.
 */
export function registerLanguage(
  language: ScriptLanguage,
  opts: RegisterLanguageOptions = {},
): ScriptTag {
  const name = language.name;
  // Registered under the name verbatim, so `languageFor(lang.name)` always finds it back —
  // which a surrounding-whitespace name would quietly break.
  if (!name?.trim() || name !== name.trim()) {
    throw new Error(
      `tektonic: a ScriptLanguage needs a non-empty \`name\` with no surrounding whitespace ` +
        `to be registered (got ${JSON.stringify(language.name)})`,
    );
  }
  if (LANGUAGES.has(name)) {
    throw new Error(
      `tektonic: script language "${name}" is already registered. Overriding it would change ` +
        `every body that uses the name, so registration refuses: pick a distinct name, or ` +
        `check whether two copies of the same package are installed.`,
    );
  }
  const extensions = (opts.extensions ?? []).map(normalizeExtension);
  LANGUAGES.set(name, { language, extensions });
  for (const ext of extensions) {
    const owner = EXTENSIONS.get(ext);
    if (owner && owner !== name) {
      // eslint-disable-next-line no-console
      console.warn(
        `tektonic: file extension "${ext}" was claimed by script language "${owner}" and is ` +
          `now claimed by "${name}" — scriptFromFile and \`tektonic lint\` will read these ` +
          `files as "${name}". Register a distinct extension, or pass an explicit language.`,
      );
    }
    EXTENSIONS.set(ext, name);
  }
  return tag(language);
}

/**
 * Removes a registered language and the extensions it currently owns, returning whether
 * anything was removed.
 *
 * Registration is module-global and permanent by design; this exists so a test that
 * registers a throwaway language can clean up after itself.
 */
export function unregisterLanguage(name: string): boolean {
  const reg = LANGUAGES.get(name);
  if (!reg) return false;
  LANGUAGES.delete(name);
  for (const ext of reg.extensions) {
    if (EXTENSIONS.get(ext) === name) EXTENSIONS.delete(ext);
  }
  return true;
}

/** Resolves a language name to its plugin, throwing on an unregistered name. */
export function languageFor(name: LanguageName): ScriptLanguage {
  const reg = LANGUAGES.get(name);
  if (!reg) {
    throw new Error(
      `Unknown script language "${name}" (expected one of ${registeredLanguageNames().join(', ')})`,
    );
  }
  return reg.language;
}

/** Names of every registered language, in registration order. */
export function registeredLanguageNames(): string[] {
  return [...LANGUAGES.keys()];
}

/** The language claiming `ext` (dot optional, case-insensitive), or `undefined`. */
export function languageNameForExtension(ext: string): string | undefined {
  return EXTENSIONS.get(normalizeExtension(ext));
}

/** Every claimed file extension, dot-prefixed — what `tektonic lint` walks. */
export function registeredExtensions(): string[] {
  return [...EXTENSIONS.keys()];
}

/** Per-body opt-outs from a framework guard. */
export interface ScriptOptions {
  /**
   * Permit a non-zero `exit` in a body the exit-code contract wraps. Only nushell rejects
   * one by default (its `exit` is untrappable and bypasses the wrapper); set by
   * {@link unsafeAllowExit} so the decision is visible at the call site.
   */
  allowExit?: boolean;
}

/** A script body paired with the {@link ScriptLanguage} that should render it. */
export class Script {
  constructor(
    readonly language: ScriptLanguage,
    readonly body: string,
    readonly options: ScriptOptions = {},
  ) {}
}

/**
 * States that a non-zero `exit` in this body is deliberate, so nushell renders it instead of
 * failing synthesis.
 *
 * The exit still terminates the process before the capture wrapper runs: the failure reaches
 * the status reporter through Tekton's own per-step exit code, but with no `error [task/step]`
 * line to explain it. Prefer `error make {msg: "..."}`; reach for this only when the exit code
 * itself carries meaning (a watchdog signalling a specific code, say).
 *
 * @example
 * ```ts
 * script: unsafeAllowExit(nu`if $over_budget { exit 99 }`)
 * ```
 */
export function unsafeAllowExit(script: Script): Script {
  return new Script(script.language, script.body, { ...script.options, allowExit: true });
}

/**
 * A body emitted verbatim — no shebang, no preamble, no exit-code capture.
 *
 * The framework's contract only holds for bodies it wraps, so opting out has to be a stated
 * decision rather than a side effect of a string starting with `#!`. Use it when the step
 * writes {@link EXIT_CODE_PATH} itself, or runs an interpreter tektonic has no plugin for.
 *
 * @example
 * ```ts
 * script: rawScript(`#!/usr/bin/env nu\n# writes the contract file itself\n...`)
 * ```
 */
export class RawScript {
  constructor(readonly body: string) {}
}

/** Marks a body as deliberately unwrapped. See {@link RawScript}. */
export function rawScript(body: string): RawScript {
  return new RawScript(body);
}

/** Object form accepted by `TaskStepSpec.script`, e.g. `{ language: 'python', body: '…' }`. */
export interface ScriptObject {
  language: LanguageName;
  body: string;
}

/** Anything accepted by `TaskStepSpec.script`. */
export type ScriptInput = string | Script | ScriptObject | RawScript;

/**
 * Removes surrounding blank lines and the common leading indentation from a
 * template body, preserving relative indentation (important for Python). Tabs
 * are normalised to four spaces first.
 */
export function dedent(text: string): string {
  const lines = text.replace(/\t/g, '    ').split('\n');
  while (lines.length && lines[0].trim() === '') lines.shift();
  while (lines.length && lines[lines.length - 1].trim() === '') lines.pop();
  const indents = lines
    .filter((l) => l.trim().length)
    .map((l) => (l.match(/^ */) ?? [''])[0].length);
  const min = indents.length ? Math.min(...indents) : 0;
  return lines.map((l) => l.slice(min)).join('\n');
}

/**
 * A reusable piece of a script body, authored with its own natural indentation.
 *
 * A plain multi-line string interpolated into a tagged template keeps the column it was
 * written at: its lines do not pick up the indentation of the interpolation site, and because
 * {@link dedent} strips the *common* minimum, one flush-left fragment leaves every other line
 * of the template indented. Fragment authors worked around that by writing shared snippets
 * flush-left at column 0 — indentation as load-bearing convention, enforced by nothing.
 *
 * A `Fragment` is re-indented to wherever it is interpolated, so shared snippets can be
 * written naturally and composed at any depth.
 *
 * @example
 * ```ts
 * const retry = fragment`
 *   n=0
 *   until [ $n -ge 3 ]; do "$@" && break; n=$((n+1)); sleep 5; done
 * `;
 *
 * const body = sh`
 *   set -e
 *   ${retry}
 *   retry curl -fsSL "$URL"
 * `;
 * ```
 */
export class Fragment {
  constructor(readonly body: string) {}
  toString(): string {
    return this.body;
  }
}

/** The indentation of the line currently being built, used to re-indent a {@link Fragment}. */
function currentIndent(text: string): string {
  const line = text.slice(text.lastIndexOf('\n') + 1);
  return /^[ \t]*$/.test(line) ? line : '';
}

function interpolate(strings: TemplateStringsArray, values: unknown[]): string {
  let out = '';
  strings.forEach((s, i) => {
    out += s;
    if (i >= values.length) return;
    const value = values[i];
    if (value instanceof Fragment) {
      // Re-indent every line but the first, which already sits at the interpolation column.
      const indent = currentIndent(out);
      out += value.body.split('\n').join(`\n${indent}`);
      return;
    }
    out += String(value);
  });
  return out;
}

function tag(language: ScriptLanguage) {
  return (strings: TemplateStringsArray, ...values: unknown[]): Script =>
    new Script(language, dedent(interpolate(strings, values)));
}

/**
 * Tagged-template helper authoring a reusable {@link Fragment} of script, dedented on its own
 * and re-indented wherever it is interpolated. Fragments compose: a fragment may interpolate
 * other fragments.
 */
export function fragment(strings: TemplateStringsArray, ...values: unknown[]): Fragment {
  return new Fragment(dedent(interpolate(strings, values)));
}

// The built-ins go through the same registry a third party uses — there is no privileged
// path into it, which is the only way the seam stays honest.

/** Tagged-template helper authoring a POSIX sh step body, e.g. ``sh`echo hi` ``. */
export const sh = registerLanguage(new Sh(), { extensions: ['.sh'] });
/** Tagged-template helper authoring a bash step body, e.g. ``bash`echo hi` ``. */
export const bash = registerLanguage(new Bash(), { extensions: ['.bash'] });
/** Tagged-template helper authoring a nushell step body, e.g. ``nu`print hi` ``. */
export const nu = registerLanguage(new Nushell(), { extensions: ['.nu'] });
/** Tagged-template helper authoring a python step body, e.g. ``py`print("hi")` ``. */
export const py = registerLanguage(new Python(), { extensions: ['.py'] });

/** Object-form helper: `script({ language: 'python', body: '…' })`. */
export function script(spec: ScriptObject): Script {
  return new Script(languageFor(spec.language), dedent(spec.body));
}

/**
 * Resolves a {@link ScriptInput} to the final step `script` string at synth time.
 *
 * - A {@link Script} (from a tag or {@link script}) is rendered by its language.
 * - A {@link ScriptObject} is rendered by the named language.
 * - A {@link RawScript} is emitted verbatim — the explicit opt-out from wrapping.
 * - A raw string that begins with a shebang is passed through unchanged, except in a task
 *   that reports status: there, passing through silently drops the exit-code contract the
 *   reporter depends on, so it is rejected in favour of a language tag or {@link rawScript}.
 * - A raw string without a shebang is rendered with `defaultLanguage` if one is
 *   set, otherwise passed through unchanged.
 */
export function renderScript(
  input: ScriptInput,
  ctx: ScriptCtx,
  defaultLanguage?: LanguageName,
): string {
  if (input instanceof RawScript) return input.body;
  if (typeof input === 'string') {
    if (input.startsWith('#!')) {
      if (ctx.captureExitCode) {
        throw new Error(
          `tektonic${scriptLabel(ctx)}: a raw '#!' script string is emitted verbatim, so it ` +
            `silently opts out of the exit-code contract this task's status reporter reads — ` +
            `a failure here can report green. Author the body with a language tag (sh/bash/nu/py) ` +
            `so the contract is applied, or wrap it in rawScript() if the step writes ` +
            `${EXIT_CODE_PATH} itself.`,
        );
      }
      return input;
    }
    if (defaultLanguage) return languageFor(defaultLanguage).wrap(dedent(input), ctx);
    return input;
  }
  if (input instanceof Script) {
    return input.language.wrap(input.body, { ...ctx, allowExit: input.options.allowExit });
  }
  return languageFor(input.language).wrap(dedent(input.body), ctx);
}
