# Agent Instructions

This project uses **bd** (beads) for issue tracking. Run `bd onboard` to get started.

## Quick Reference

```bash
bd ready              # Find available work
bd show <id>          # View issue details
bd update <id> --status in_progress  # Claim work
bd close <id>         # Complete work
bd sync               # Sync with git
```

## The issue graph can be silently wrong

`bd import` is upsert, but `git merge` is not. Merging a branch whose `.beads/issues.jsonl`
predates other issue activity overwrites the file wholesale, and the closures and issues it
never knew about are gone with no warning. Commit `287b508` did exactly that — four closures
reverted, three issues dropped — and because the Dolt database is gitignored and rebuilt from
that file, the next cloud session offered already-shipped work as `bd ready`.

None of the defences work today: `.gitattributes` names a `merge=beads` driver that is neither
configured nor implemented by the installed bd, and `bd hooks list` reports every hook
uninstalled. Tracked as **tektonic-1cz**.

Until it is fixed: after any merge or rebase touching `.beads/issues.jsonl`, diff the file
against the branch you merged (`git show <other>:.beads/issues.jsonl`) before trusting
`bd ready`, and re-import anything the merge dropped.

**A merge is not the only way.** A cloud container once started with a database *behind* the
committed JSONL — no merge involved — and `bd ready` offered work that had shipped weeks
earlier. `bd doctor` does not compare the two, so nothing catches it. Reconcile at session
start, before claiming anything:

```bash
bd import .beads/issues.jsonl      # upsert; prints what it changed
```

`bd import` **skips rows the local database has a newer copy of**, mentioning it only as
`(1 stale skipped)`. If you have already touched an issue this session, that row stays wrong —
`bd import --allow-stale` restores it from the file.

## `bd update --notes` replaces, it does not append

Issue notes here carry the audit trail that makes a blocked issue resumable, and one `--notes`
wipes all of it with nothing but a stderr warning. Use `--append-notes`:

```bash
bd update <id> --append-notes "what you found"   # adds, newline-separated
bd update <id> --notes "..."                     # destroys what was there
```

Recover a clobbered set from the committed JSONL, which holds whatever was last exported.

## Landing the Plane (Session Completion)

**When ending a work session**, you MUST complete ALL steps below. Work is NOT complete until `git push` succeeds.

**MANDATORY WORKFLOW:**

1. **File issues for remaining work** - Create issues for anything that needs follow-up
2. **Run quality gates** (if code changed) - Tests, linters, builds
3. **Update issue status** - Close finished work, update in-progress items
4. **PUSH TO REMOTE** - This is MANDATORY:
   ```bash
   git pull --rebase
   bd sync
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

## CI and Automation

All CI and automation runs through tektonic itself — the pipelines in `.tekton/`,
synthesized from `examples/self-ci.ts`. Do not add GitHub Actions workflows. The one
exemption is `.github/workflows/publish.yml`, which exists only because npm's trusted
publishing cannot accept a self-hosted cluster as an OIDC issuer. `.github/` holds that
one file and nothing else; a second workflow was proposed and rejected (tektonic-4p3).

An agent session cannot write under `.github/workflows/` — neither `git push` nor the
GitHub API will, for want of `workflow` scope. Write the patch, verify it, record the
exact content on the issue, and hand it to a human. See CLAUDE.md.

Renovate is self-hosted, so `postUpgradeTasks` in `renovate.json` re-synthesizes
`.tekton/` after an image bump. See CLAUDE.md for the `allowedCommands` requirement.

## Cross-Repo Planning

`tektonic` (`@tektonic-ci/core`) is the TypeScript library consumed by `ocidex` (`make tekton-synth`) and `homelab/.tektonic/`. It sits in the middle of the dependency chain: `apko-cicd → tektonic → ocidex/homelab`. Cross-cutting initiatives that span multiple repos are tracked in `~/code/common/` (issue prefix: `plan`).

- `bd list` here shows only this repo's issues. For every repo at once, use the hub: `cd ~/code/common && bin/hub sync && bd ready` (or `bd blocked`, `bd list`)
- Cross-repo epics (work spanning 2+ repos) live in the hub: `cd ~/code/common && bin/hub sync`, `bd create --type=epic ...`, then `bd dep add plan-xyz <issue-id-in-this-repo>`. See `~/code/common/CLAUDE.md`
- When a local issue is part of a cross-repo initiative, also note it here: `bd update <id> --append-notes "Parent epic: plan-xyz"` (`--notes` would replace existing notes)
- File issues in the repo where the change lands; don't add a tracking copy in a consumer repo
- Changes here typically propagate downstream: bump the npm dep in `ocidex` and `homelab/.tektonic/`, then re-synth


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
