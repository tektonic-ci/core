# Dev Environment

This project uses **[Flox](https://flox.dev)** for environment management. `node`, `npm`, and all other project tooling are **only available inside the activated Flox environment**.

When running CLI commands non-interactively (e.g. from a shell that was not started with `flox activate`), prefix every command with `flox activate --`:

```bash
flox activate -- npm test
flox activate -- npm run build
flox activate -- npm run synth
```

The environment is defined in `.flox/env/manifest.toml` and currently provides:
- Node.js 24 (`nodejs_24`, in its own package group so it can move ahead of the other pins; npm bundled, 11.19+ for `npm stage`)
- Beads (`bd`) — AI-native issue tracker CLI
- Repomix — codebase packer for AI context

## Common Commands

| Action | Command |
|---|---|
| Run tests | `flox activate -- npm test` |
| Build (compile TS) | `flox activate -- npm run build` |
| Synthesize manifests | `flox activate -- npm run synth` |
| Check committed manifests | `flox activate -- npm run check` |
| Install dependencies | `flox activate -- npm install` |
| Watch mode tests | `flox activate -- npm run test:watch` |
| List issues | `flox activate -- bd list` |
| Update codebase snapshot | `flox activate -- repomix` |

## Cloud Sessions (Claude Code on the web)

A cold container has no Flox, so `bd`, `node` and the Dolt database are all absent.
Two SessionStart hooks, which run in parallel, handle it:

- `.claude/hooks/beads-session-start.sh` (shared by every repo, vendored from
  pfenerty/planning by `~/code/common/bin/hub vendor`; edit it there, not here)
  `go install`s `bd` pinned to the local version, rebuilds the Dolt database from the
  committed `.beads/issues.jsonl` (or, if one exists, imports only newer rows),
  configures the `merge=beads` driver, and runs `bd prime`.
- `.claude/hooks/session-start.sh` runs `npm install`.

Two things worth knowing:

- **`.beads/issues.jsonl` is the interchange format.** The Dolt database itself is
  gitignored, so a cloud session only sees issues that have been exported and
  committed. bd auto-exports after each write; commit the file alongside your work.
  The setup is the same in every repo and is documented in the planning hub
  (`~/code/common/CLAUDE.md`).
- **Merges of the file are row-level.** `.gitattributes` routes it to `merge=beads`:
  per issue, the newer `updated_at` wins. Locally the driver is
  `~/code/common/bin/bd-jsonl-merge`, configured globally. In a cloud container the
  beads SessionStart hook points it at the vendored `.claude/hooks/bd-jsonl-merge`. Any
  other environment (a CI runner, a fresh clone with no hooks run) falls back to a line
  merge. Commit `287b508` shows what that can do: it reverted four closures and dropped
  three issues from main. There, after any merge or rebase that touches the file,
  compare it with the branch you merged (`git show <other>:.beads/issues.jsonl`)
  before trusting `bd ready`.
- **Bringing the database up to date with the file.** Locally, the global git hooks run
  `~/code/common/bin/bd-import-newer` after merges, rebases and branch checkouts. It
  imports only rows that are missing or newer in the file. Run it by hand if you pulled
  some other way. **Don't reach for plain `bd import`:** in bd 1.0.3 it overwrites rows
  without comparing timestamps, so an older file silently reverts newer local edits
  (verified 2026-10-13; no "stale skipped" check exists). In a fresh cloud container the
  database is rebuilt from the file by the hook above, so it starts in sync.
- **Never run a bare `bd init` in a checkout that already has beads.** It rewrites
  `CLAUDE.md`, `AGENTS.md`, `.claude/settings.json` and the git hooks, and commits the
  result. The hook uses `--skip-agents --skip-hooks --from-jsonl` and reverts the
  commit bd makes anyway.

Outside a cloud container the hook is close to a no-op: every install step is guarded
on the tool being missing, and the rebuild is guarded on the database being absent.

## Issue Tracking

Beads (`bd`) is configured at `.beads/`. Use it for ALL task tracking — no markdown TODOs.

```bash
bd ready                              # find available work
bd create --title="..." --type=task   # create before starting work
git checkout main && git pull         # start from latest main
git checkout -b <branch-name>         # one branch per issue
bd update <id> --status=in_progress   # claim it before coding
# → implement the change
git add <changed files>               # stage only relevant files
git commit -m "feat/fix: description (<issue-id>)"  # commit BEFORE closing
bd close <id>                         # mark done AFTER committing
```

**Critical:** `bd close` without a prior `git commit` leaves changes stranded on disk.
Always include the issue ID in the commit message (e.g. `feat: add source-branch param (tektonic-wq6)`).

**`bd update --notes` REPLACES the notes field — it does not append.** Issue notes here
accumulate the audit trail that makes a blocked issue resumable, and a single `--notes`
wipes all of it with only a warning on stderr. Use `--append-notes` to add to them:

```bash
bd update <id> --append-notes "what you found"   # adds, newline-separated
bd update <id> --notes "..."                     # destroys what was there
```

If you do clobber a set of notes, recover them from the committed JSONL — that copy is
whatever was last exported: `python3 -c "import json;[print(json.loads(l)['notes']) for l in open('.beads/issues.jsonl') if json.loads(l)['id']=='<id>']"`.

Issue types: `bug`, `feature`, `task`, `epic`, `chore`
Priorities: `0`=critical, `1`=high, `2`=medium (default), `3`=low, `4`=backlog

## Session Completion

Work is NOT complete until pushed. Before ending a session:

1. Verify all completed work is committed: `git status` must show no modified tracked files
2. Close finished issues, file issues for remaining work
3. Run quality gates if code changed (`flox activate -- npm test && flox activate -- npm run build`)
4. Push:
   ```bash
   git pull --rebase && git push
   git status  # must show "up to date with origin"
   ```

## CI and Automation

This repo is `tektonic-ci/core`, and it publishes `@tektonic-ci/core` alone. The provider
packages live in sibling repos in the same org, [`tektonic-ci/cache-gcs`](https://github.com/tektonic-ci/cache-gcs)
and [`tektonic-ci/reporter-github`](https://github.com/tektonic-ci/reporter-github) (cloned at
`~/code/cache-gcs` and `~/code/reporter-github`). Each has its own self-CI, its own trusted
publisher, and its own `CLAUDE.md`. The org profile README lives in `tektonic-ci/.github`.

**All CI and automation runs through tektonic itself** — the pipelines in `.tekton/`,
synthesized from [`examples/self-ci.ts`](examples/self-ci.ts). Do not reach for GitHub
Actions to automate something; if a job needs adding, it belongs in the self-CI pipeline.

The one exemption is [`.github/workflows/publish.yml`](.github/workflows/publish.yml),
and only because npm's trusted publishing accepts GitHub Actions, GitLab CI/CD and
CircleCI as OIDC issuers — a self-hosted cluster cannot be a trusted publisher. That
constraint is the whole reason it exists; nothing else inherits the exemption. The rule is
the same in every package repo in the org: each has exactly one `publish.yml`, bound to that
repo's own trusted publisher on npm. Core's copy loops over the workspace, and a provider's
copy publishes its single package.

**`.github/` holds that one file and nothing else**, and the exemption has already been
tested once: a `renovate-synth.yml` workflow was written to re-synthesize `.tekton/`
after an image bump, then rejected (tektonic-4p3) because self-hosted Renovate's
`postUpgradeTasks` does the same job inside the rule. If you find yourself reaching for a
second workflow, that is the precedent — solve it in `examples/self-ci.ts`, in
`renovate.json`, or in the cluster.

**An agent session cannot write under `.github/workflows/` at all.** Both routes are
refused for want of `workflow` scope — `git push` with *refusing to allow an OAuth App to
create or update workflow … without `workflow` scope*, and the GitHub API with
*Insufficient scope: required "repo workflow"* — on tokens that create branches and write
every other path fine. Do not plan work that depends on such a change landing in-session:
write the patch, verify it, put the exact content in the issue, and hand it to a human.
tektonic-46j.11 is the open instance of this, confirmed four times.

Renovate is **self-hosted**, so `postUpgradeTasks` in `renovate.json` is available and is
what re-synthesizes `.tekton/` after an image bump. It needs `allowedCommands` in the
self-hosted global config to admit `^npm ci` and `^npm run synth`, or the tasks are
skipped silently.

## Codebase Context

`repomix-output.xml` is a packed snapshot of the entire codebase used as AI context. It is not tracked in git. Regenerate it after significant changes:

```bash
flox activate -- repomix
```

## Using Tektonic

See [`docs/agent-guide.md`](docs/agent-guide.md) for a full guide on creating pipelines with this library.


<!-- BEGIN BEADS INTEGRATION v:1 profile:minimal hash:ca08a54f -->
## Beads Issue Tracker

This project uses **bd (beads)** for issue tracking. Run `bd prime` to see full workflow context and commands.

### Quick Reference

```bash
bd ready              # Find available work
bd show <id>          # View issue details
bd update <id> --claim  # Claim work
bd close <id>         # Complete work
```

### Rules

- Use `bd` for ALL task tracking — do NOT use TodoWrite, TaskCreate, or markdown TODO lists
- Run `bd prime` for detailed command reference and session close protocol
- Use `bd remember` for persistent knowledge — do NOT use MEMORY.md files

## Session Completion

**When ending a work session**, you MUST complete ALL steps below. Work is NOT complete until `git push` succeeds.

**MANDATORY WORKFLOW:**

1. **File issues for remaining work** - Create issues for anything that needs follow-up
2. **Run quality gates** (if code changed) - Tests, linters, builds
3. **Update issue status** - Close finished work, update in-progress items
4. **PUSH TO REMOTE** - This is MANDATORY:
   ```bash
   git pull --rebase
   bd dolt push
   git push
   git status  # MUST show "up to date with origin"
   ```
5. **Clean up** - Clear stashes, prune remote branches
6. **Verify** - All changes committed AND pushed
7. **Hand off** - Provide context for next session

**CRITICAL RULES:**
- Work is NOT complete until `git push` succeeds
- NEVER stop before pushing - that leaves work stranded locally
- NEVER say "ready to push when you are" - YOU must push
- If push fails, resolve and retry until it succeeds
<!-- END BEADS INTEGRATION -->
