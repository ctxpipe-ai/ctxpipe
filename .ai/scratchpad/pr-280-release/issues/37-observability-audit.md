# Audit observability: each user action is captured in HyperDX and Langfuse

Status: done
Priority: P1
Owner: claude
Blocked by: none
Created: 2026-10-11
Updated: 2026-10-11

## Context

The product sends logs, traces and metrics over OTLP to the self-hosted ClickStack (HyperDX), and LLM traces to Langfuse (ADR-038, ops/observability/USING.md). While debugging tickets 26, 27 and 29, the team found gaps:
- HyperDX was not available at times (504);
- production had 0 UI browser spans for two days, while pr-280 had thousands;
- one UI server-render path had no span.

The CTO wants an end-to-end check: do real actions in the product UI and through MCP, then confirm that HyperDX and Langfuse captured each of them correctly.

## Scope

On the pr-280 preview, with the team's test org:
- **Browser:** sign in, open the org home, Workspaces, the Files pane, the graph pane and connectors, start a chat turn that uses tools, Commit+Push, and open a page that fails, such as an unknown slug.
- **MCP:** connect to the product MCP of the test org and call the main tools (search, graph, file read, memory).
- **Ingestion or hydrate:** if one runs during the test, check it too.

For each action, check:
- **HyperDX:** the document and API request spans, backend spans with the correct `DeploymentEnvironment` and service name, browser (`ui`) spans, the links between browser, backend, worker and codesearch spans (trace context), logs with the trace id, error status on failures, and useful attributes (org, Workspace and route, with no secrets and no PII beyond the ids we allow).
- **Langfuse:** each LLM call of the chat turn and of MCP tools that call a model, with the prompt, the model, token counts, cost, latency, and a link to the HyperDX trace if one exists.
- **Production (read-only):** whether production UI browser spans are still missing, and why.

## Acceptance criteria

- [x] A table in Comments: each action, whether HyperDX captured it (with the trace id), whether Langfuse captured it (with the trace id), and the gaps.
- [x] Each gap or error found has its own ticket, numbered from 40 up in `.ai/scratchpad/pr-280-release/issues/`, with evidence, the likely cause and the files involved.
- [x] No fixes in this ticket. The team lead assigns the new tickets.

## Comments

Run on the pr-280 preview with the team's test org, 2026-10-11 01:07 to 01:24 UTC (API key revoke at 03:42 UTC). Driver: headless Playwright (the shared browser pane was not available to this agent), curl for MCP. HyperDX answered every query; no 504 in this window. Langfuse trace and observation rows were read from ClickHouse (`langfuse.traces` / `langfuse.observations` with `FINAL`) through HyperDX, because the Langfuse MCP has no trace-query tool.

| Action (UTC) | HyperDX | Langfuse | Gaps |
| --- | --- | --- | --- |
| Wake `/.status` 01:07:36 | yes, `b8aa1e0b084f35024c71f38cc51c1066`, env `pr-280`, service `backend` | n/a | none |
| Sign in 01:10:27 | yes, browser + backend in one trace `fa663efd3ce43208a1fba93c3f252062` | n/a | sign-in document has no span and its log has no trace id (45); first `get-session` fetches have no `traceparent` (46) |
| Org home 01:11:52 | yes, `289c4100692c87b0eecb005b14f5a57a` (activity), `ui` documentLoad and page_view present | n/a | document request untraced (45) |
| Workspace 01:11:56 | yes, `9ebe40905359e199cca1908f7a6cb3d2`, `479c5ba895e2a34c8bdb52f7b315f3bf`; org attributes on API spans | n/a | none beyond 45 |
| Files pane 01:11:58 | yes, `6e3aefdde693913260f2ed4875c10193` (tree), `c85e9581d6c337f83fd802fb23b4da90` (status) | n/a | none |
| Graph pane 01:12:00 | yes, `9f678190256eed7b80f71871c6324b31` | n/a | console noise (50) |
| Connectors 01:12:01 | yes, `703bf0abb03a2e58e3c66a5c3050a571`, `518295f53ab4ac44f17ef9194a524b9a` | n/a | none |
| Unknown org slug 01:12:03 | backend auth calls only; no `ui` span at all | n/a | no error signal; browser spans lost (46) |
| Unknown Workspace slug 01:12:07 | backend 404 `abac40316dabf8e41725068ac616f261`; browser span lost | n/a | 46 |
| Create Workspace (own test repo) 01:15:01 | yes, browser + backend + `workflow_run.create` in `908eac52824840b16ec12a3b325c0f8b` | n/a | none |
| Hydrate + ingestion 01:15 to 01:23 | yes, `workspace-hydrate` runs, codesearch spans join the ingestion trace `1e261e6a2130bf0436e71e13e6e9d5e2` | yes, ingestion generations with model and tokens | false FalkorDB errors (47); no org tag (44); no cost (43) |
| Chat turn with tools 01:17:54 | partial: six separate traces, one per model call (`cad42b8c20a845ca8fd2b5ca8bec2c36` and five more); turn span alone in `a556044174efe5cf73a5df98f4fc44ff` | partial: same ids; generations have no model, tokens, prompt, or cost | 41, 42, 43, 44; agent git identity error (49) |
| Commit+Push 01:19:35 | yes, browser + backend + Vercel sandbox calls + logs with trace id, `f32e7008c3ef12d71cce1647abaca922` | n/a | none |
| MCP initialize / tools/list 01:23:27 | yes, `b443bad7cd79eb62ced26f8be9c66d92`, `ced4bbae222b91f676d216576d5230ff`, actor `org_api_key`, `ctxpipe.api_key.id` set, secret absent | n/a | none |
| MCP `ctx_advisor` 01:23:35 | yes, one trace `0ae4180de87efbe8a934fceebcc1b5b8` with `mcp.tool ctx_advisor` and `workspace-chat.turn` | yes, same id, model and 754 tokens; per-call generations empty; orphan `read`/`glob`/`grep` traces | 42, 43, 44, 47 |
| MCP search / graph / file read / memory | n/a: the product MCP lists only `ctx_advisor` | n/a | not a gap (by design, see preview-env MCP area) |
| API key revoke 03:42:51 | the next call returns 401 | n/a | none |
| Production `ui` spans (read only) | last span 2026-10-07T23:31:47Z | n/a | no signed-in browser traffic since then; pr-280 merge will make the relay refuse production (40) |

Other errors seen on pr-280 during the run: `workspace-tip-check` fails on a private repository (48); a graph 503 on another agent's Workspace, with a browser error span not joined to the request (50).

## Resolution

Done. Eleven tickets, 40 to 50: P1 40, 41, 42; P2 43, 44, 45, 46, 48; P3 47, 49, 50.

Production browser spans: the relay on main is not broken; production had no signed-in browser traffic after 2026-10-07 23:31 UTC (no `user` actor spans and no relay calls from 2026-10-08 to 2026-10-11). The real risk is pr-280: its relay accepts only origins in the UI `AUTH_BASE_URL` / `AUTH_ALLOWED_ORIGINS`, and Terraform sets neither to the public origin for production (ticket 40).

Left on the preview for the team lead: Workspace `pe-t37-20261011-ws` with its test repository `ctxpipe-ai/pe-t37-20261011-ws` and one chat conversation; one hidden MCP conversation on the org's first Workspace. The API key was revoked.
