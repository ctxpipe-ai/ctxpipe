# Chat progress shows only real status: counters, one thinking block, and a detailed log

Status: done (needs review)
Priority: P1
Owner: claude
Blocked by: none
Created: 2026-10-11
Updated: 2026-10-11

## Context

While the chat agent works, the conversation shows progress labels. Some of them are made up and do not describe real work, for example "Traversing Your Graph". The CTO wants only real status. A screenshot from 2026-10-11 also shows several thinking blocks open at the same time, under the counters line "Read 15 files · 3 searches · Used 11 tools".

## Spec (from the CTO)

1. **Counters line:** keep the counters, as today, for example "Read 15 files · 3 searches".
2. **Thoughts counter:** add a counter of thinking blocks, for example "3 thoughts", on the same line as the other counters. Each thinking block is also an entry in the log, the expandable list of tools and thoughts.
3. **Current thought:** show only the last thinking block, for example "Inspecting knowledge units …". Never show more than one thinking block outside the log.
4. **Done:** when the answer is generated, hide the last thinking block. The counters line and the log stay.
5. **Detailed log:** each log entry shows the details it has. For example, "Read file" shows which file, a search shows its query, and a tool call shows its main argument.
6. **No fake labels:** when none of the above applies, show only a real status from the system, for example "Setting up sandbox". Otherwise show "Thinking". Remove every invented label, such as "Traversing Your Graph".

## Acceptance criteria

- [x] Every invented label is removed. Each status label that stays maps to a real system state, which is listed in Comments.
- [x] The counters line has a thoughts counter.
- [x] At most one thinking block shows outside the log, and it hides when the answer is done.
- [x] Log entries show file paths, search queries and tool arguments where the data has them. The backend masks known credential formats before the stream leaves the server and before the transcript is stored.
- [x] Storybook stories with play tests cover: working with a current thought, working with only a system status, the "Thinking" fallback, done, and an expanded log.
- [x] UI tests and golden stories pass.

## Comments

- Labels removed: the rotating list "Contextualizing…", "Analyzing…", "Traversing your graph…", "Reading knowledge…", "Checking sources…" in `apps/ui/src/features/chat/ConversationThread.tsx`.
- Status labels that stay, with their source:
  - The title of the current thought: the last heading (or the short first line) of the `thinking` parts, from the AG-UI `REASONING_MESSAGE_*` events.
  - "Setting up sandbox": the backend `CUSTOM` event `sandbox-setup` with `phase: "starting"` (`workspaceChatSandboxSetupChunk` in `apps/backend/src/domain/workspaces/workspace-chat-agui.ts`).
  - "Thinking": the fallback while the run is `submitted` or `streaming`.
- The workspace prepare steps "Fetching repository" and "Reading knowledge" in `WorkspaceHydrateProgress.tsx` stay. They map to the real hydrate views `waiting_for_tip` and hydrating.
- Log details come from the tool-call `input` or the streamed `arguments` JSON, which already reach the UI: file path, search pattern or query, symbol, or command.
- Credentials: the backend masks each chat chunk before it leaves the server (`streamTanstackWorkspaceChat`), and it masks the transcript before it is stored (`saveThread` in `workspace-chat-persistence.ts`). One pure function, `maskCredentials` in `apps/backend/src/domain/workspaces/mask-credentials.ts`, covers GitHub token prefixes, `sk-` keys, `Bearer` values, `Authorization` header values, and user and password parts of URLs. The UI does not mask again.
- The mask also covers a URL password with an empty user, the signed run capability shape, and the message of a run error. An Authorization value is masked only when a scheme (Bearer, Basic, token, Digest) and a value follow, so code such as `authorization: string` stays. Quotes and backslashes end a value, so masked JSON stays valid. Every rule is bounded, so the time is linear in the text length.
- Text and reasoning deltas: each message holds back a tail of about 100 characters, cut at whitespace, until its end, the end of the run, or a run error. So a credential that crosses deltas is masked in the stream and in the MCP result.
- Limits of the mask: it is a pattern match, so an unknown credential format passes. Transcripts stored before this change are not masked.
- Sandbox tokens today: the git commands in the sandbox refer to the clone token by its variable name (`$CTXPIPE_CLONE_TOKEN`), not by its value. Hosted runs get GitHub credentials from the firewall, and `GH_TOKEN` is a placeholder. A tool result can still show the value if the agent prints the environment. The mask applies in all cases.
- The status line stays until the run ends, also while text streams in the middle of the run. The `ctx-indexing-dot` pulse stops under reduced motion, and the dot stays visible.

## Resolution

One thought is one heading section of a reasoning text, so one reasoning block with three headings counts as "3 thoughts". Text before the first heading belongs to the first thought. The counters line opens one "Activity log" with the thoughts and the tool calls in order. Stories: `WorkingWithThought`, `SettingUpSandbox`, `ThinkingFallback`, `ThinkingFallbackWithTools`, `ChatProgressDone` (golden), `ChatProgressLogExpanded` (golden), `InterimTextKeepsStatus`, `NextTurnShowsStatus`.
