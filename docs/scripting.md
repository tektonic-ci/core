# Scripting

Steps run scripts. Tektonic treats those scripts as a first-class, typed, **testable**
part of your pipeline rather than as opaque strings buried in YAML. You can author a step
body inline with a language-tagged template, or — better for anything non-trivial — keep it
in a real `.sh`/`.bash`/`.nu`/`.py` file that your editor highlights, your linter checks,
and your test suite can execute.

This guide covers the four ways to author a script, how the language plugins work, the
exit-code contract the framework owns for you, and how to test scripts.

## The four authoring forms

`TaskStepSpec.script` accepts a `ScriptInput`, which is one of:

```typescript
import { sh, bash, nu, py, script, scriptFromFile } from '@tektonic-ci/core';

// 1. Tagged template — inline, language inferred from the tag
script: sh`echo "hello from POSIX sh"`
script: bash`set -euo pipefail; echo "bashisms allowed"`
script: nu`print "hello from nushell"`
script: py`print("hello from python")`

// 2. Object form — when the language name is dynamic
script: script({ language: 'python', body: 'print("hi")' })

// 3. From a separate file — language inferred from the extension
script: scriptFromFile(path.join(__dirname, 'build.sh'))   // → sh
script: scriptFromFile(path.join(__dirname, 'fmt.nu'))     // → nushell

// 4. Raw string (legacy / back-compat)
script: '#!/bin/sh\necho hi'   // a shebang string is passed through unchanged
```

Tagged templates and `scriptFromFile` both run through `dedent()`, so you can indent the body
to match the surrounding TypeScript and the common leading indentation is stripped (relative
indentation is preserved, which matters for Python).

### Extension → language mapping

`scriptFromFile` infers the language from the file extension:

| Extension | Language |
|-----------|----------|
| `.sh`     | `sh` (POSIX) |
| `.bash`   | `bash` |
| `.nu`     | `nushell` |
| `.py`     | `python` |

The table is not fixed: it is the registry, and a language registered with
`registerLanguage(lang, { extensions: ['.rb'] })` claims its own extensions alongside these.
See [Registering your own language](#registering-your-own-language).

Override the inference when the extension is ambiguous or unconventional:

```typescript
scriptFromFile(path.join(__dirname, 'check'), { language: 'sh' })
```

A leading shebang in the file is **stripped** when loaded (the language plugin adds its own at
synth time). This lets the file keep a shebang so it stays runnable and lint-friendly on its
own, without that shebang being duplicated in the rendered step.

## Scripts in separate files (recommended)

Keeping step bodies in real files is the point of the scripting system: you get syntax
highlighting, `shellcheck`/`py_compile`/`nu-check` linting, and — crucially — the ability to
run the script directly in a test. A task then becomes a thin, declarative wrapper:

```typescript
// jobs/go-fmt/spec.ts
import * as path from 'path';
import { Task, scriptFromFile } from '@tektonic-ci/core';
import { goImage, statusReporter } from '../../shared';

export const goFmt = new Task({
  name: 'go-fmt',
  statusReporter,
  steps: [
    { name: 'fmt', image: goImage, script: scriptFromFile(path.join(__dirname, 'fmt.nu')) },
  ],
});
```

```nu
# jobs/go-fmt/fmt.nu
#!/usr/bin/env nu
log "Checking gofmt"
let unformatted = (^gofmt -l . | complete | get stdout | str trim)
if ($unformatted | str length) > 0 {
  print "Unformatted files:"; print $unformatted
  error make {msg: "gofmt: formatting issues found"}
}
log "OK: all files formatted"
```

The `log` helper used above is **provided by the language preamble** — every plugin injects a
timestamped `log` at synth time, so you don't define it yourself.

A static script can be loaded once and reused across many tasks with per-task differences
passed as step `env`. ocidex's image-build does exactly this: one `build.sh` shared across five
image tasks, parameterised by `IMAGE`/`DOCKERFILE`/`TARGET` env vars.

## Interpolating params, workspaces, and results

`Param`, `Workspace`, and `Result` stringify to Tekton expressions, so they drop straight into
a tagged template:

```typescript
const ref = new Param({ name: 'ref' });
const ws = new Workspace({ name: 'source' });

script: sh`
  cd ${ws.path}          # → $(workspaces.source.path)
  git checkout ${ref}    # → $(params.ref)
`
```

This works for inline tags only. For `scriptFromFile`, pass values through step `env` instead
(the file can't see your TypeScript variables), e.g. `env: [{ name: 'REF', value: `${ref}` }]`
and reference `$REF` in the script.

## The language plugins

Each language is a `ScriptLanguage` plugin that knows three things: its shebang, how to `wrap`
a user body (preamble + exit-code contract), and the command used to lint an extracted file.

| Language  | Shebang | Lint command | Notes |
|-----------|---------|--------------|-------|
| `sh`      | `#!/bin/sh` | `shellcheck` | Portable default for Alpine/BusyBox/Wolfi |
| `bash`    | `#!/usr/bin/env bash` | `shellcheck` | Extends `sh`; same body handling, bash shebang |
| `nushell` | `#!/usr/bin/env nu` | `nu-check` (wrapped) | Body runs inside `def main []` for capture |
| `python`  | `#!/usr/bin/env python3` | `python3 -m py_compile` | Body runs inside `def _tek_main()` |

All four inject a timestamped `log` helper in their preamble.

### Registering your own language

The four built-ins are not privileged: they go through the same public registry any other
package uses. `registerLanguage` takes a `ScriptLanguage` and returns its tagged-template
helper, so registration and use are one step and the call site never names a string:

```typescript
// @acme/tektonic-lang-ruby
import { registerLanguage, type ScriptCtx, type ScriptLanguage } from '@tektonic-ci/core';

class Ruby implements ScriptLanguage {
  readonly name = 'ruby';
  readonly shebang = '#!/usr/bin/env ruby';

  wrap(body: string, ctx: ScriptCtx): string {
    if (!ctx.captureExitCode) return `${this.shebang}\n${body}`;
    // Run the body, persist the real code to ctx.exitCodePath, re-exit with it.
    return [ /* … */ ].join('\n');
  }

  lintCommand(file: string): string[] {
    return ['ruby', '-c', file];
  }
}

export const rb = registerLanguage(new Ruby(), { extensions: ['.rb'] });
```

Importing that module is all a consumer does. From then on the language reaches every
ergonomic the built-ins have:

```typescript
import { rb } from '@acme/tektonic-lang-ruby';

script: rb`puts "hi"`                                  // the returned tag
script: script({ language: 'ruby', body: 'puts 1' })   // the object form
script: scriptFromFile('./check.rb')                   // extension inference
new Task({ name: 'x', defaultLanguage: 'ruby', … })    // task/project default
// and `tektonic lint` walks .rb files through `ruby -c`
```

`LanguageName` is open (`KnownLanguageName | (string & {})`), so an out-of-tree name
type-checks wherever a built-in does while `'nushell'` still autocompletes.

Registry rules worth knowing:

- **A name may be registered once.** A second registration throws rather than overriding —
  silently replacing a language would change every body that uses the name, at a distance.
  Two copies of the same package in a tree is the usual cause; make tektonic a peer
  dependency, as [job-libraries.md](job-libraries.md) describes.
- **A conflicting extension warns and the last registration wins.** Pass an explicit
  `{ language }` to `scriptFromFile` when two languages want the same extension.
- **The exit-code contract is not optional.** A `wrap` that ignores `ctx.captureExitCode`
  or writes to a path other than `ctx.exitCodePath` makes a failed step report *green*.
  Prove compliance with the conformance helper below.
- `unregisterLanguage(name)` exists for tests that register a throwaway language.

#### Proving the contract

`@tektonic-ci/core/testing` exports `assertExitCodeContract`, which renders a body through
your `wrap`, executes it with the real interpreter, and asserts both the process exit code
and the contract file:

```typescript
import { assertExitCodeContract, interpreterAvailable } from '@tektonic-ci/core/testing';

it.skipIf(!interpreterAvailable('ruby'))('honours the exit-code contract', () => {
  assertExitCodeContract(new Ruby(), {
    interpreter: 'ruby',
    extension: '.rb',
    failing: code => `exit ${code}`,
    succeeding: 'puts "ok"',
  });
});
```

It throws a described failure on a violation ("does not re-exit with the body's code", "does
not write the real exit code to the contract file"). The static checks — shebang first, body
preserved, `ctx.exitCodePath` honoured — run even when the interpreter is missing, in which
case the result carries `skipped`.

### Default language for bare bodies

A raw string **without** a shebang is rendered with a default language when one is set —
`Task.defaultLanguage`, falling back to the project-level `defaultLanguage`
(`TektonicProject`). A tagged body always carries its own language and ignores the
default; a raw string **with** a shebang is always passed through untouched.

```typescript
new Task({
  name: 'build',
  defaultLanguage: 'sh',
  steps: [{ name: 'build', image, script: 'echo hi' }], // wrapped as sh
});
```

## The exit-code contract (handled for you)

When a task has both a `statusReporter` and a `statusContext`, the reporter needs the real exit
code of your work even though the step must use `onError: 'continue'` so the reporting step
still runs. Tektonic owns this plumbing:

- The framework sets `onError: 'continue'` on your steps and tells the language plugin to
  **capture** the exit code.
- The plugin wraps your body so it runs, records the **worst** exit code seen across the task's
  steps to `EXIT_CODE_PATH` (`/tekton/home/.exit-code`), and re-exits with its own code.
- The plugin also prints `error [<task>/<step>]: <message>` when the body fails, so a report-only
  task (`failOnError: false`) says in its log what went wrong rather than just turning red.
- The reporter's final step decides success/failure from the **worst** of that file and Tekton's
  own `/tekton/steps/step-<name>/exitCode` for each user step.

You therefore **do not** hand-write `echo $? > /tekton/home/.exit-code` or set
`onError` — write the body as if it runs normally and `exit`/`error make`/`sys.exit` naturally.

### Two ways the contract used to be lost — both now fail synthesis

**A non-zero `exit` in a nushell body.** nushell's `exit` cannot be trapped: it kills the process
before the wrapper records anything, leaving the contract file on its seeded `0`. The failure
survives only through Tekton's own per-step exit code, with no `error [task/step]` line to say
what happened — and in a hand-rolled drift check that reported green on drift for months. So a
non-zero `exit` in a capturing nu body is now a synth-time **error**:

```
tektonic [tekton-check/check]: nushell 'exit 1' terminates before the wrapper can record what
failed, leaving the exit-code contract on its seeded 0. Raise instead — error make {msg: "..."}
— or wrap the body in unsafeAllowExit() if the exit is deliberate.
```

Use `error make {msg: "..."}`, which keeps both the failure and its message. `exit 0` stays
fine: an early return from a body with nothing to do cannot hide a failure. When the exit code
itself carries meaning (a watchdog signalling a specific code), state that at the call site:

```typescript
import { nu, unsafeAllowExit } from '@tektonic-ci/core';

script: unsafeAllowExit(nu`if $over_budget { exit 99 }`)
```

**A raw `#!` string.** Wrapping only applies to tagged/object/file scripts (and bare strings
rendered via a default language). A string that begins with a shebang is emitted verbatim — so
in a task that reports status it silently opts out of the contract the reporter reads, and a
failure there can report green. That is now rejected too. Either author the body with a language
tag, or state the opt-out with `rawScript()` when the step writes `EXIT_CODE_PATH` itself or
runs an interpreter tektonic has no plugin for:

```typescript
import { rawScript } from '@tektonic-ci/core';

script: rawScript(`#!/usr/bin/env ruby\n# this step owns its own exit-code handling\n...`)
```

Outside a reporting task a raw `#!` string still passes through unchanged — there is no contract
to lose.

## Composing bodies from fragments

Shared snippets are `fragment` tags, not plain strings. A plain multi-line string interpolated
into a template keeps the column it was written at, and because `dedent` strips the *common*
minimum indentation, one flush-left snippet leaves every other line of the template indented —
which is why hand-written snippet libraries had to be authored flush-left at column 0, with the
convention enforced by nothing but a comment.

A `fragment` is dedented on its own and **re-indented wherever it is interpolated**, at any
depth, and fragments compose:

```typescript
import { fragment, sh } from '@tektonic-ci/core';

const retry = fragment`
  n=0
  until [ $n -ge 3 ]; do "$@" && break; n=$((n+1)); sleep 5; done
`;

script: sh`
  set -e
  retry() {
    ${retry}
  }
  retry curl -fsSL "$URL"
`
```

## Embedding a shell body in nushell

Some work is shell work — a `trap`, a polling loop over a cgroup file, a tool that expects to be
`exec`'d from `sh`. `embedSh` embeds a POSIX `sh` body inside a nushell script as a fragment:

```typescript
import { embedSh, nu } from '@tektonic-ci/core';

const watchdog = embedSh(
  `limit=$1
   while :; do
     used=$(cat /sys/fs/cgroup/memory.current)
     [ "$used" -gt "$limit" ] && exit 99
     sleep 5
   done`,
  { args: [memoryLimitBytes] },
);

script: nu`
  ${watchdog}
  log "watchdog exited"
`
```

The body goes into a nushell **raw string**, so nushell never looks inside it — which is why
values cannot be interpolated across the boundary and are passed as positional parameters
(`$1`, `$2`, `"$@"`) instead. `args` accepts anything stringifiable, so a `Param` or `Result`
renders its Tekton expression and is double-quoted for you. The raw-string fence widens
automatically if the body contains one. `exit` codes inside the body belong to the embedded
`sh` process: they do not touch the exit-code contract, and the nushell `exit` guard ignores
them.

### Two interpolation traps

- **Bare parentheses in an interpolated nushell string.** Inside `$"…"`, `(…)` is an
  expression to evaluate. A value that may contain parentheses (a commit subject, say) must not
  be interpolated into `$"…"` — bind it with `let` from a plain `"…"` string first.
- **`$(...)` collides with Tekton.** Tekton substitutes its own `$(params.…)`,
  `$(workspaces.…)` and `$(results.…)` before the script ever runs, so shell command
  substitution written as `$(cmd)` reads as a Tekton variable to anyone scanning the manifest,
  and to Tekton's own validation for prefixes it recognises. Prefer backticks in `sh` bodies,
  or nushell's own `(cmd)` evaluation.

## Testing scripts

> Testing whole **pipelines** — graph shape, gating, params — is covered in
> [testing.md](testing.md).

Because a script is a real file with a known interpreter, you can render it through its plugin
and execute it for real in a unit test. This is the pattern Tektonic uses for its own plugins
(`packages/tektonic/src/lib/script/runtime.test.ts`): render with `wrap`, run with the interpreter, assert both
the process exit code and the captured contract file.

```typescript
import { spawnSync } from 'child_process';
import { Nushell } from '@tektonic-ci/core';

const wrapped = new Nushell().wrap(
  'error make {msg: "boom"}',
  { exitCodePath: '/tmp/ec', captureExitCode: true },
);
// write `wrapped` to a temp .nu file, run `nu file`, assert status === 1
```

To test your own job scripts, point a test at the same `.nu`/`.sh` file the task loads (e.g.
run `gofmt`-less fixture dirs through `fmt.nu` and assert it fails). Skip a case when its
interpreter is unavailable so the suite stays hermetic (`it.skipIf(!has('nu'))`).

### Lint harness

`tektonic lint` (or `npm run lint:scripts`) walks every file under `src/` whose extension a
registered language claims — `.sh`/`.bash`/`.nu`/`.py` out of the box, plus anything
`registerLanguage` added — and runs that language's `lintCommand` (`shellcheck`, `nu-check`,
`py_compile`, …). It skips gracefully when a linter isn't installed and fails only on real
syntax errors. The command chooser is exported
as `lintCommandForFile(filePath, { language? })` if you want to build your own harness over a
consumer repo's script files.

## API reference

| Export | Description |
|--------|-------------|
| `sh` / `bash` / `nu` / `py` | Tagged-template helpers returning a `Script` |
| `script({ language, body })` | Object-form helper |
| `scriptFromFile(path, { language? })` | Load a `Script` from a file, language inferred from extension |
| `Script` | A body paired with its `ScriptLanguage` |
| `Sh` / `Bash` / `Nushell` / `Python` | The built-in language plugin classes |
| `languageFor(name)` | Resolve a `LanguageName` to its plugin |
| `registerLanguage(lang, { extensions? })` | Register a language; returns its tagged-template helper |
| `unregisterLanguage(name)` | Remove a registered language (for tests) |
| `registeredLanguageNames()` / `registeredExtensions()` | What the registry currently holds |
| `languageNameForExtension(ext)` | The language claiming a file extension, if any |
| `languageNameForFile(path, override?)` | Infer a language name from a file extension |
| `lintCommandForFile(path, { language? })` | The lint argv for a script file |
| `dedent(text)` | Strip common leading indentation (used internally by the tags) |
| `renderScript(input, ctx, defaultLanguage?)` | Resolve a `ScriptInput` to its final string (synth-time) |
| `EXIT_CODE_PATH` | The canonical contract path, `/tekton/home/.exit-code` |
| `stepOutputPath(step)` | Where a step's captured output tail lands when its reporter sets `captureStepOutput` |
| `DEFAULT_STEP_OUTPUT_MAX_BYTES` | Default cap on that file, 64 KiB |
| `ScriptInput` / `ScriptObject` / `LanguageName` / `KnownLanguageName` / `ScriptTag` / `ScriptLanguage` / `ScriptCtx` | Types |
| `assertExitCodeContract` / `interpreterAvailable` (`/testing`) | Conformance harness for a language |

To add a new language, implement `ScriptLanguage` and register it — see
[Registering your own language](#registering-your-own-language) and
[architecture.md](architecture.md#extension-points).
