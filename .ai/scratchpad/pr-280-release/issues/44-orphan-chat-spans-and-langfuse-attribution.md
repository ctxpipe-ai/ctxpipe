# Chat tool spans become root traces with no org, and some Langfuse traces have no org tag

Status: ready-for-human
Priority: P2
Owner: agent (obs-llm-traces)
Blocked by: 41
Created: 2026-10-11
Updated: 2026-10-11

## Context

Langfuse and HyperDX filter by org and environment (`org:<slug>`, `env:<environment>`, metadata `orgId`). Some chat and ingestion telemetry has none of these.

## Evidence

`pr-280`, 2026-10-11:

- Langfuse root traces named `read`, `glob`, and `grep` (for example `33f4030558f62576b1c636e69ccc1263`, `8f376068fe796235411d23c4275f5c74`, `ab315a7ee75329637e9a1cdbe6879d10`, 01:23:3x UTC) with no session, no tags, and no environment. In HyperDX they are `tool read` spans with no parent, only `gen_ai.tool.*` and `workspace_chat.turn_id`.
- The TanStack turn span (`a556044174efe5cf73a5df98f4fc44ff`, 01:18:00 UTC) has the tags `["ui","env:pr-280"]`, no `org:` tag, no `orgId` metadata, and `user.id` in place of `enduser.id`.
- Repository ingestion traces (`1e261e6a2130bf0436e71e13e6e9d5e2`, `55ce5ddb22ef430e2c1096b630e0047c`) have the tags `["env:pr-280","repository-ingestion"]` and no `org:` tag, although the codesearch child spans carry `ctxpipe.org.id`.
- The embedding trace `eaf31039ce5f942fb9ef753a939709c8` has only `env:pr-280`.

Likely cause: `apps/backend/src/domain/workspaces/workspace-chat-otel.ts` starts `tool <name>` spans when no request context is active, with no attribution copied. `apps/backend/src/domain/workspaces/tanstack-workspace-chat.ts` builds the TanStack span tags itself. The ingestion and embedding Langfuse callbacks (`apps/backend/src/observability/langfuse.ts`) do not get the org from the job input.

## Expected vs actual

- Expected: every Langfuse trace has `env:` and `org:` tags and `orgId` / `orgSlug` metadata, and every span has a parent in its turn or job. Use `enduser.id`, not `user.id` (observability skill, key table).
- Actual: as above.

## Scope

- Copy attribution to tool and turn spans (after ticket 41 gives them a parent).
- Use the shared tag builder for the TanStack span.
- Pass the org from the ingestion job input to the Langfuse handler.

## Acceptance criteria

- [ ] No Langfuse trace in a preview chat, MCP, or ingestion run lacks the `org:` tag.
- [ ] No `tool <name>` span is a root span.

## Comments

## Resolution

Cause: tool spans started with no parent and no attribution (ticket 41). The socket turn had no attribution bag, so `runWithLangfuseContext` found no org and wrote only the `ui` and `env:` tags. A job input has the org id but usually no org slug, and the `org:` tag needs the slug.

Fix (branch `obs-llm-traces`):

- Tool and generation spans are children of the turn root and copy the turn attribution (ticket 41).
- The socket sets the org, user, actor, and conversation attribution for each turn step (`withSocketTurnContext`).
- `beginWorkspaceChatTurn` applies the shared Langfuse builder (`langfusePropagation`, split out of `runWithLangfuseContext`) to the turn context. Every span of the turn, the TanStack `chat <model>` span too, gets `org:<slug>`, `env:<environment>`, and `orgId` / `orgSlug` metadata.
- `defineObservedWorkflow` reads the org slug from `organizations` when a job input has only the org id, and gives it to the job attribution (the body input does not change). A failed lookup leaves the tag out and does not fail the job. This covers repository ingestion.
- `user.id` on the TanStack span is the Langfuse `userId` key, which Langfuse needs. The same spans now also carry `enduser.id` from the attribution bag.

Tests: `workspace-chat-otel.test.ts` asserts the org attributes, the `org:acme` tag, the `orgId` metadata, and the parent on each generation, tool, and chat span. `conversation-websocket.attribution.test.ts` asserts the socket attribution and tag. `defineObservedWorkflow.integration.test.ts` asserts the slug lookup against a real database.

Open: the embedding trace (`openai/text-embedding-3-large`, only `env:`) runs where no attribution bag is active. This change does not find that caller. If it stays without `org:` after the deploy, find its caller from the trace and run it in the job or request attribution.

To prove after a deploy: no Langfuse trace from a preview chat, MCP call, or ingestion run lacks `org:`, and no `tool <name>` span is a root in HyperDX.


Review round 1: `beginWorkspaceChatTurn` now builds the one turn context: the attribution (with the sender, for the socket) and the Langfuse attributes (session, user, source tag, org tag, trace name). The Langfuse turn wrapper in `transport.ts` and the attribution bag in the socket wrapper are gone. The socket keeps its auth and logger wrapper, which is not telemetry. The org slug lookup for jobs moved into `restoreJobTelemetry`. It reads a slug once per org and process, uses the enqueue telemetry slug when that is present, and logs a warning when the read fails.
