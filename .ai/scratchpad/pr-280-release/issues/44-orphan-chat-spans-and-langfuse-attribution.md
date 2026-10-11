# Chat tool spans become root traces with no org, and some Langfuse traces have no org tag

Status: ready-for-agent
Priority: P2
Owner: unassigned
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
