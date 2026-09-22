# Agent playbook

`@johnhenry/a2a-query` — reactive, cached, embeddable A2A client for
non-agentic apps: agent-card registry, task-handle store, approval broker,
built on the official `@a2a-js/sdk`. Single package, Node >= 22 (see
`package.json` `engines` — the family floor is `>=26.0.0`, but this repo's CI
genuinely runs 22; raising it is a deliberate human decision, not something
to change here), vitest (`npm test`), builds to `dist/` via
`tsc -p tsconfig.build.json`. A `demo/` subdirectory is its own npm project
with its own lockfile — don't assume a root `npm install` covers it.

`CLAUDE.md` in this directory is a symlink to this file.

## The verification loop (before every push)

1. `npm run typecheck`
2. `npm test` (vitest) — no suite here is allowed to SKIP.
3. `npm run test:coverage` — v8 provider, statements threshold 85%
   (`vitest.config.ts`). This is a separate CI step from `npm test`, not
   implied by it.
4. `npm run build && npm pack --dry-run` — read the file list, not just the
   exit code; `files` is `["dist"]` only.
5. A genuinely fresh clone:
   `git clone . /tmp/a2a-query-verifyN && cd $_ && npm ci && npm run build && npm test`.
6. If you touched `demo/`:
   `npm --prefix demo install --no-audit --no-fund && npm --prefix demo run build && npm --prefix demo test`
   — the demo is a separate npm project with its own CI job (`demo-build`),
   not exercised by the root suite at all.
7. Commit, push, close the issue with a comment naming the commit SHA.

CI (`.github/workflows/ci.yml`) runs two independent jobs. `build-test`:
`npm ci` → `npm run typecheck` → `npm test` → `npm run test:coverage` →
`npm run build` → an entrypoint import smoke test. `demo-build`: `npm ci`
(working-directory `demo`) → `npm run build` → `npm test`, both inside
`demo/`. Match this order locally.

## Repo-specific gotchas

- **`@a2a-js/sdk` is pinned exactly (`1.0.1`), not a caret range**, as both a
  `peerDependency` and a `devDependency`. The SDK only just reached its 1.0
  general-availability release and its surface may still shift — a caret
  range could silently pull in a breaking minor before this package has
  verified against it. Bumping it is a deliberate PR, not a routine
  `npm update`.
- **`demo/` is its own npm project.** `npm install` at the repo root does not
  install the demo's dependencies; every demo script (`demo:dev`,
  `demo:build`, `demo:test`) runs `npm --prefix demo install` first for
  exactly this reason. Editing files under `demo/` without running its own
  install/build will pass the root CI job and still break `demo-build`.
- **The in-process mock agent is not a real endpoint.** `@johnhenry/a2a-query/testing`
  wires the SDK's own server stack (`DefaultRequestHandler` +
  `JsonRpcTransportHandler` + `InMemoryTaskStore`) behind an injected
  `fetch` — every example and most tests run against this, not a live agent.
  Pointing at a real agent means swapping the fetch/endpoint, not the API.
- **An unconfigured webhook token means no auth check at all.**
  `createWebhookHandler`'s `token` option is optional; omitting it accepts
  any POST that parses as a valid push. Never wire this up without a token
  outside tests — see `## Security model` in the README.
- **`npm run test:coverage` enforces the 85% statements floor, `npm test`
  does not.** Both run on every push in CI as separate steps; don't assume a
  green `npm test` implies coverage passed.

## Definition of done

A change is done when all of the following hold, not just when tests pass:
- A regression test exists for any bug fixed.
- Anything the feature does **not** do is stated in the README (or the
  code), not only in an issue comment.
- `CHANGELOG.md` has an entry citing the commit/PR.
- If `examples/` changed shape (new file, renamed capability),
  `examples/README.md`'s table and the root `example:NN` script are updated
  together — the two must never drift.
- If `docs/api.md` or `docs/design.md` claims changed, they're re-checked
  against the actual export/behavior, not left as-is.

## Non-goals

- a2a-query does not negotiate or select A2A protocol versions — that's the
  `@a2a-js/sdk`'s (and the agent's) job. See the README's "Supported
  protocol versions" section for exactly what this means and does not mean.
- a2a-query is not a security sandbox for untrusted agent code — see
  `## Security model` in the README for the precise trust boundary it does
  and does not draw.

## Releases

Bump `version` in `package.json` in a PR, add the `CHANGELOG.md` entry,
merge, then push a tag `v<version>` (or dispatch
`.github/workflows/release.yml` manually) — this repo's publish trigger is
tag-push + `workflow_dispatch`, not the family's `release: published`
standard, gated on typecheck + test + build (no coverage step), guarded by
the `npm view` pre-flight idempotency check before
`npm publish --provenance --access public --tag <rc|latest>`. The trigger
deviation has no explanatory comment in `release.yml` yet — a known gap from
the family CI standard, left for the separate CI-migration phase rather than
fixed here.
