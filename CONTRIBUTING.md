# Contributing

## Development setup

This project uses [Flox](https://flox.dev/) for environment management. All commands should be run inside `flox activate`.

```bash
flox activate
npm install
```

## Commands

All of these run from the repository root.

```bash
npm run build         # tsc -b → packages/tektonic/dist/
npm test              # build, then the test suite (vitest)
npm run synth         # synthesize this repo's own CI → .tekton/
npm run check         # fail if the committed .tekton/ output is stale
npm run graph         # print the self-CI task DAG (FORMAT=mermaid for a flowchart)
npm run lint:scripts  # lint extracted .sh/.bash/.nu/.py files
npm run api:check     # fail on a breaking public-API change (see below)
npm run api:update    # rewrite packages/tektonic/api/ after a public-API change
```

## Project structure

See [docs/architecture.md](docs/architecture.md) for how these pieces fit together and the
extension points.

This repository holds core alone, `@tektonic-ci/core` in `packages/tektonic/`. The provider
packages live in repos of their own, built and released against the published core:

| Package | Repo |
|---|---|
| `@tektonic-ci/reporter-github` — `GitHubStatusReporter` | [tektonic-ci/reporter-github](https://github.com/tektonic-ci/reporter-github) |
| `@tektonic-ci/cache-gcs` — `GcsBackend`, `GcsArtifactStore` | [tektonic-ci/cache-gcs](https://github.com/tektonic-ci/cache-gcs) |

They take core as a **peer** dependency and can reach only its published surface, because
that is all npm gives them. When a provider genuinely needs something core keeps internal,
export it from `packages/tektonic/src/index.ts` and document it as supported API.

This repo's own self-CI (`examples/self-ci.ts`) installs `@tektonic-ci/reporter-github` from
npm like any other project, so its peer range has to admit the core in this tree. A new core
**major** therefore can't run core's own CI until the reporter has published a release that
widens its peer range — the release order in
[ADR 0002](docs/adr/0002-npm-scope-and-versioning.md#versioning-continue-the-2x-line-and-version-each-package-independently).

At a glance, inside `packages/tektonic` — every bare `src/…` path below is relative to it:

```
src/
├── index.ts                      # public API re-exports (the entire public surface)
├── constants.ts                  # API versions, defaults, security contexts, images
├── cli/                          # the `tektonic` CLI (synth, check, graph, lint)
└── lib/
    ├── core/                     # primitives, orchestrators, extension interfaces
    │   ├── param.ts  workspace.ts  result.ts
    │   ├── task.ts               # TaskDef (aka Task)
    │   ├── pipeline.ts  git-pipeline.ts  pipeline-task.ts
    │   ├── tektonic-project.ts   # builds the SynthModel, runs the targets
    │   ├── hub-task-ref.ts  trigger.ts  trigger-events.ts
    │   └── cache-backend.ts  status-reporter.ts  synth-target.ts   # extension interfaces
    ├── script/                   # ScriptLanguage plugins (sh/bash/nushell/python) + from-file
    ├── cache/                    # PvcBackend + shared helpers published for backend authors
    └── targets/                  # SynthTarget implementations (pac/, tekton/)
examples/
├── main.ts                       # Go pipeline example
└── self-ci.ts                    # this project's own CI pipeline
docs/                             # see README.md for the full doc index
```

## Testing

Tests use [vitest](https://vitest.dev/) and live alongside source files as `*.test.ts`.

```bash
npm test              # single run
npm run test:watch    # watch mode
```

Two patterns dominate (both detailed in [docs/architecture.md](docs/architecture.md#testing)):

- **Synthesis assertions** — construct primitives, build a spec, and assert the resulting object
  shape (params inferred, `runAfter` correct, cycle rejected).
- **Script runtime** — render a body through a `ScriptLanguage.wrap`, execute it with the real
  interpreter, and assert the exit code *and* the contract file. See
  `src/lib/script/runtime.test.ts`; guard each case with `it.skipIf(!has(interpreter))` so the
  suite stays hermetic.

Run `tektonic lint` (or `npm run lint:scripts`) to syntax-check any `.sh`/`.bash`/`.nu`/`.py` files under `src/`.

## Pull requests

1. Create a feature branch from `main`
2. Make your changes
3. Ensure `npm run build`, `npm test` and `npm run api:check` pass
4. Open a PR against `main`

### Public API changes

Anyone can write a provider against core's extension points (`StatusReporter`,
`CacheBackend`, `ArtifactStore`, `SynthTarget`), so there is no list of consumers to test a
change against. `npm run api:check`, which self-CI runs as `check-api`, asks the compiler
instead. It does two things:

- **The API report.** `packages/tektonic/api/*.api.md` records every export's declaration,
  and the check fails when it no longer matches the build. Run `npm run api:update` and
  commit the result, so a public API change is always a visible diff in review.
- **Compatibility with the last release.** The check downloads the declarations of
  `@tektonic-ci/core@latest` and compiles each export's old form against its new one. An
  interface or type alias must be assignable in both directions, so code implementing the
  old type must still satisfy the new one, and values of the new type must still fit
  where the old type was. A class must accept its old constructor arguments and keep its
  public members. A function must stay callable the way it was.

A break doesn't block the merge; it has to be declared. Add a section under `## Unreleased`
in `CHANGELOG.md` whose heading starts with `### Breaking`, saying what broke and how to
migrate. The check then passes and still prints what it found, for the reviewer. Later PRs
pass on the same declaration until the release. The release PR moves `## Unreleased` under
a version heading, so from then on only a major version bump satisfies the check. A
release that should have been a major can't merge as a minor. A prerelease such as
`3.0.0-rc.0` counts as a major. Additive changes pass: a new export, a new
**optional** member, or a widened parameter. A new required member on an interface is a
break, even on one core only ever hands out, because the check cannot tell which interfaces
someone implements.

Private and protected class members are not API and are ignored. So are the values of
constants: an image pin changing is a behaviour change, not a type break.
`API_BASELINE=<version>` compares against a version other than `latest`.

The script needs the TypeScript compiler API to read the declarations, and TypeScript 7
offers it only as `typescript/unstable/*`. So the script downloads TypeScript 5 into its
gitignored work dir, `packages/tektonic/.api-compat/`. The project's own TypeScript 7
still judges compatibility. TypeScript 5 is not a devDependency because every
`typescript` package ships a `tsc` bin, and a second copy made install order decide which
compiler `npm run build` used. If the check itself fails to compile, it fails outright,
whatever the CHANGELOG declares.

## Dependency updates

Renovate opens the dependency PRs. Image pins are the awkward case: they live in TypeScript,
and `.tekton/` is synthesized from it, so the tags in the committed manifests are output.

Renovate only ever saw that output. Its Ansible manager matches any `tasks/*.yaml`, so
`.tekton/tasks/*.k8s.yaml` was rewritten by accident of the path while the TypeScript that
generates it stayed behind — the bumps were real, `npm run check` was red, and the next
`npm run synth` would have reverted them.

So the pins themselves are under Renovate now, through a `customManagers` regex in
`renovate.json` covering `packages/tektonic/src/lib/constants.ts` and `examples/self-ci.ts`. Add a file to that list when it grows a versioned image literal; a
floating tag such as `base:stable` is skipped, since the regex requires a leading digit.
(`config:recommended` ignores `examples/` by default, which is why `ignorePaths` is spelled
out in full without it.)

Renovate groups every update of one image onto a single branch whatever manager found it, so
a bump arrives as one PR carrying the source change and the manifests that follow from it.
The `check-manifests` step in the self-CI `test-npm` task is the guard that keeps that honest:
it runs `npm run check`, which synthesizes into a temp directory and diffs against what is
committed, and its exit code is folded into the GitHub status. **If it fails, run
`npm run synth` and commit the result** — the TypeScript wins, always.

## Releasing

`@tektonic-ci/core` is published to npmjs by the `publish` GitHub Actions workflow
(`.github/workflows/publish.yml`), triggered by a `vX.Y.Z` tag. The provider packages release
from their own repos, each with its own workflow and trusted publisher, and only when they
change; the workflow refuses to publish unless the tag matches `packages/tektonic/package.json`.

Publishing uses npm **trusted publishing** (OIDC) with **staged publishing**: the workflow
mints a short-lived credential from its `id-token: write` permission, so no npm token exists
anywhere — not in the repo, not in the cluster — and uses it to *stage* each package with a
provenance attestation. A staged version is not installable until a maintainer approves it
with 2FA. The trusted publishers are deliberately left without npm's "publish directly"
option, so push access to the repo is not enough to release; the approval is the gate.

It lives in Actions rather than in Tektonic's own Tekton pipeline because npm only accepts
GitHub Actions, GitLab CI/CD and CircleCI as OIDC issuers; a self-hosted cluster cannot be a
trusted publisher (npm lists self-hosted runner support as planned). Everything else — test,
build, SBOM and vulnerability scan — still runs in Tekton on push and pull request.

### The git ref is not an install channel

`npm install github:pfenerty/tektonic` worked before the workspace split and **must not be
suggested as a fallback.** It does not fail — which is the
problem:

```
npm install github:pfenerty/tektonic
# -> added 1 package: node_modules/tektonic-workspace
# -> no dist/, no bin, require.resolve('@tektonic-ci/core') throws
```

The ref resolves to the repository root, which is now the private `tektonic-workspace` package:
no `main`, no `exports`, no `bin`, and none of the `prepare: npm run build` that made the git
ref work when the root *was* `@tektonic-ci/core`. npm has no way to install a subdirectory of
a git dependency, so there is no ref that reaches `packages/tektonic` either. The install
reports success and leaves the consumer with nothing.

The registry is the channel; the git ref is not, and the README says so.

### Cutting a release

1. Bump `version` in `packages/tektonic/package.json`, move the CHANGELOG's "Unreleased"
   entries under it, then commit and push to `main`. If "Unreleased" has a `### Breaking`
   section, the version must be a new major, and `check-api` fails the release PR until it is.
2. `git pull` and tag **the merged commit** on `main` as `vX.Y.Z`, then push the tag. A tag on
   a stale local `main` names the wrong tree, and the workflow's version check is what stops it.
   The workflow refuses to stage when the tag does not match the package version, re-runs
   `npm test` and `npm run build`, and stages the package unless that version is already on the
   registry.
3. Approve the stage with your passkey. `npm stage` needs npm 11.19 or later; the flox
   environment's npm has it, so run this inside `flox activate`. The stage id is on the
   "staged with id" line of the workflow log, or:

   ```bash
   npm stage list @tektonic-ci/core                  # note the stage id
   npm stage approve <stage-id> --auth-type=web
   ```

   `npm stage download <stage-id>` fetches the tarball if you want to inspect it first, and
   `npm stage reject <stage-id>` discards one. Re-running the workflow before approving stages
   the package again — reject the duplicate.

4. Check the release: `npm view @tektonic-ci/core@X.Y.Z gitHead` must be the tagged commit.

A **major** release of core has an ordering constraint: the provider repos declare a peer range
on core's major, and this repo's own self-CI installs `@tektonic-ci/reporter-github`. Publish a
core prerelease, release the providers with a widened peer range, then release core
([ADR 0002](docs/adr/0002-npm-scope-and-versioning.md)).

### One-time setup

Trusted publishing is configured on a package page, and a name that has never been published
has no page, so a new package's very first publish is manual. `@tektonic-ci/core` got a
deprecated `0.0.0-bootstrap` placeholder on the `bootstrap` dist-tag for this, published with
web auth (`npm login --auth-type=web`, then `npm publish --access public --tag bootstrap
--auth-type=web`) because a passkey is the only 2FA some accounts have. A brand-new package can
404 on `npm view` for a minute or more afterwards while the registry catches up — that is not a
failed publish, and `npm deprecate` fails the same way until it does.

Then register the GitHub Actions publisher on npmjs.com → the package → Settings → Trusted
Publisher: `tektonic-ci` / `core` / `publish.yml`, Environment blank, and leave "can also
publish directly" **unchecked**. Use the website: `npm trust github` returned a bare
`400 Bad Request`. Each provider package is registered the same way against its own repo.

> Tokens are not a fallback here. npm revoked all classic automation tokens in December 2025,
> granular tokens with write access expire within 90 days, and since July 2026 a granular token
> cannot publish at all, whatever its bypass-2FA setting. Interactive 2FA and trusted publishing
> are the two remaining paths — which is why CI uses OIDC.

## Code conventions

- TypeScript strict mode
- vitest for testing
- cdk8s patterns for Kubernetes resource generation
- TSDoc comments on all public API surface
