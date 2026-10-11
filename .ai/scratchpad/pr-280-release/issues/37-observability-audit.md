# Audit observability: each user action is captured in HyperDX and Langfuse

Status: in progress
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

- [ ] A table in Comments: each action, whether HyperDX captured it (with the trace id), whether Langfuse captured it (with the trace id), and the gaps.
- [ ] Each gap or error found has its own ticket, numbered from 40 up in `.ai/scratchpad/pr-280-release/issues/`, with evidence, the likely cause and the files involved.
- [ ] No fixes in this ticket. The team lead assigns the new tickets.

## Comments

## Resolution
