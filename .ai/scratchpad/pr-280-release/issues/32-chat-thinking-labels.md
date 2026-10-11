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
- [x] Log entries show file paths, search queries and tool arguments where the data has them. Secrets and tokens are never shown.
- [x] Storybook stories with play tests cover: working with a current thought, working with only a system status, the "Thinking" fallback, done, and an expanded log.
- [x] UI tests and golden stories pass.

## Comments

- Labels removed: the rotating list "Contextualizing…", "Analyzing…", "Traversing your graph…", "Reading knowledge…", "Checking sources…" in `apps/ui/src/features/chat/ConversationThread.tsx`.
- Status labels that stay, with their source:
  - The title of the current thought: the last heading (or the short first line) of the `thinking` parts, from the AG-UI `REASONING_MESSAGE_*` events.
  - "Setting up sandbox": the backend `CUSTOM` event `sandbox-setup` with `phase: "starting"` (`workspaceChatSandboxSetupChunk` in `apps/backend/src/domain/workspaces/workspace-chat-agui.ts`).
  - "Thinking": the fallback while the run is `submitted` or `streaming`.
- The workspace prepare steps "Fetching repository" and "Reading knowledge" in `WorkspaceHydrateProgress.tsx` stay. They map to the real hydrate views `waiting_for_tip` and hydrating.
- Log details come from the tool-call `input` or the streamed `arguments` JSON, which already reach the UI: file path, search pattern or query, symbol, or command. No backend change was necessary.

## Resolution

One thought is one heading section of a reasoning text, so one reasoning block with three headings counts as "3 thoughts". The counters line opens one "Activity log" with the thoughts and the tool calls in order. Stories: `WorkingWithThought`, `SettingUpSandbox`, `ThinkingFallback`, `ThinkingFallbackWithTools`, `ChatProgressDone` (golden), `ChatProgressLogExpanded` (golden).
