# OpenCode prompt() can end the stream before assistant text

Status: historical

The 0.2.5 version pin and attach/idle-wait workaround are historical. Product chat is stock TanStack (`@tanstack/ai@0.48` + `@tanstack/ai-opencode@0.3.4`); see [ADR-030](../../../memory/decisions/ADR-030-workspace-chat-stock-tanstack.md).

Stock `@tanstack/ai-opencode@0.2.5` ended the event queue when `session.prompt()` resolved, not when `session.idle` fired. Assistant `message.part.updated` events that arrived after that were dropped. Workspace chat then saw harness echo or an empty persist reply.

## What we will not do

Do not patch or fork `@tanstack/ai*`. ServeError / echo stay our wiring. The old pin against a version bump no longer applies.

## Observed

Live MSW multi-turn (`tanstack-workspace-chat.multiturn.test.ts`) after the idle-wait patch revert can finish with `RUN_ERROR` `workspace chat produced no assistant reply` (or the leftover success log if a caller still treats empty as completed). User row is kept; no assistant is persisted.

## Follow-up

Keep consuming TanStack’s iterator until dispose + port-free. If the only text equals the prompt, persist nothing. File this against TanStack if a later adapter release still ends on `prompt()` instead of idle.
