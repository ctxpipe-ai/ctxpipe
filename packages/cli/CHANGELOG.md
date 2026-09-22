# ctxpipe

## 0.4.0

### Minor Changes

- 078c8e2: Graph ontology v2 (ADR-033). Predicates are grouped into relation families (`PART_OF`, `DECLARED_IN`, `TARGETS`, `REFERENCES`, `OWNS`, `SUPERSEDES`, `INFLUENCES`, change edges dated at merge); the overloaded `ABOUT` and the never-extracted `Concept` / `Capability` / `Topic` kinds are retired. Connector Markdown is parsed by deterministic extractors instead of the instruction LLM: Linear issues and teams (`Issue`, `Team OWNS Issue`, `Issue REFERENCES PullRequest`), Slack captures (`Thread REFERENCES PullRequest | Issue`), and the GitHub pull-request mirror (`PullRequest TARGETS Repository`, change edges, `PullRequest REFERENCES Issue`). Source repositories gain `Decision` nodes from ADR files and `Team OWNS Service | App | Library` from CODEOWNERS. One reference resolver joins URLs, identifiers and paths into shared keys. Evidence ids now follow `extractor:repositoryId:…:targetHash` so dedup, retraction and purge work for connector claims. Connector-only partial ingests skip the code extractors. New `GET /knowledge-graph/quality` (join density, orphans, evidence per claim). A healthy full ingest retracts leftover connector-derived instruction units; there is no second cleanup path. Instruction units are minted only from files whose purpose is to instruct (agent files, rules, skills, CONTRIBUTING, root and package READMEs, norm-named docs); other Markdown stays search-only. References to pull requests of connected repositories and to known-team Linear issues create stub nodes that the mirror later enriches; Linear issues derive their team from the identifier prefix when the mirror lacks it. Manual re-index (UI **Retry indexing**, `reindex-repositories` script) is now a full re-ingest: it ignores the last ingested commit and, after a healthy run, retracts evidence the repository no longer asserts, so re-indexing stops accumulating drifted LLM extractions; re-observed evidence is stamped with the run and the current commit. Re-ingest connected repositories after deploying.
- 9c9e889: Add API-key MCP auth as an OAuth alternative: `--auth api-key` writes a client-specific interpolation of `CTXPIPE_API_KEY` (never the secret) into repo or user MCP config. Mint organisation keys in Organisation settings; personal keys remain under User account. `doctor mcp` sends `x-api-key` when `CTXPIPE_API_KEY` is set in that process. Raise dashboard API-key rate limits so MCP is usable.

### Patch Changes

- 9c9e889: Write Cursor and Claude MCP config with `"type": "http"` so Cursor Agent CLI and Desktop accept the Streamable HTTP server.
- 2881db2: Fix first-run GitHub pull-request mirror setup so context-repository binding is transactionally visible and background initialisation uses explicit organisation scope. Prevent OpenWorkflow's stale parallel-branch control signal from falsely marking successful repository ingestions as failed.

## 0.3.4

### Patch Changes

- 19293bb: Support the generic tenant-bound MCP endpoint used by the ctx| Claude plugin.
- 21a2182: Emit a Claude Code–valid Stop continuation (`decision: block` + `reason`) and stop observing PostToolUse, which minted tool dumps as memory candidates.

## 0.3.3

### Patch Changes

- 9072089: Keep memory-capture follow-ups quiet: seed a one-sentence user reply, and stay silent when nothing was promoted.

## 0.3.2

### Patch Changes

- e6085e2: Stop Cursor memory capture from recapturing Stop `followup_message` as a new lesson, and stop classifying MCP/grep/test dumps from afterFileEdit and postToolUse. Cursor hooks observe user prompts only; tool-sourced pending ids are dismissed.

## 0.3.1

### Patch Changes

- 44dd8dc: Stop memory capture from looping on Cursor Stop follow-ups. Classify user/assistant speech only, raise the lesson bar, and emit a one-shot follow-up so promotion turns cannot recapture themselves.

## 0.3.0

### Minor Changes

- 52370f7: Require organisation membership for MCP and org-scoped REST. Harden Streamable HTTP transport and add ctxpipe doctor mcp plus version-pinned MCPJam diagnostic scripts.

## 0.2.0

### Minor Changes

- 492d964: Add local memory into CLI

## 0.1.1

### Patch Changes

- 7f148d1: Publish CLI to npm (retry after failed 0.1.0 release). Read CLI version from package.json instead of a hardcoded constant.
- 70855a0: .

## 0.1.0

### Minor Changes

- fb57f34: New CLI & device code auth flow
