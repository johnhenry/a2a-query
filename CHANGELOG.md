# Changelog

## Unreleased

## 0.1.0

- **Browser transport guidance + tests** (johnhenry/a2a-query#25): new
  `docs/api.md` section "Browser transport: CORS, SSE, auth", a Node-only
  `@johnhenry/a2a-query/testing/http` entry (`serveMockAgent` — the mock agent
  behind a real socket with configurable CORS, bearer requirement and a mid-stream
  connection cut; `browserLikeFetch` — a fetch that enforces browser CORS rules),
  `test/browser-transport.test.ts`, and `examples/14-browser-transport.ts`.

- **Node 26 is the floor** (`engines.node` `>=26.0.0`, CI and release on 26,
  `.nvmrc` 26), moved in lockstep across the `*-query` family
  (agent-query-core, a2a-query, acp-query, mcp-query), the family-wide
  standard. Node 26's npm can also publish through npm trusted publishing.

## 0.0.0 — npm scope migration (2026-08-23)

First release under this name. Renamed from `@johnhenry/a2aq` during the
2026-08 agent-query family rename (`mcpq`/`a2aq`/`acpq` →
`mcp-query`/`a2a-query`/`acp-query`); the version line restarted at 0.0.0 on
rename — a new name and era, not a maturity signal. The old `@johnhenry/a2aq`
versions are deprecated on npm. Renamed in `b5f7d96` (#15); provenance
documented in `15f8f06`.
