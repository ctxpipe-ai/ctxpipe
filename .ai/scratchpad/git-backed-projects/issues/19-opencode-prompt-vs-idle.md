# OpenCode prompt() can end the stream before assistant text

Status: ready-for-human

Stock `@tanstack/ai-opencode@0.2.5` ends the event queue when `session.prompt()` resolves, not when `session.idle` fires. Assistant `message.part.updated` events that arrive after that are dropped. Workspace chat then sees harness echo or an empty persist reply.

## What we will not do

Do not patch, fork, or version-bump `@tanstack/ai*`. ServeError / echo stay our wiring unless TanStack ships an idle-wait fix.

## Observed

Live MSW multi-turn (`tanstack-workspace-chat.multiturn.test.ts`) after the idle-wait patch revert can finish with `RUN_ERROR` `workspace chat produced no assistant reply` (or the leftover success log if a caller still treats empty as completed). User row is kept; no assistant is persisted.

## Follow-up

Keep consuming TanStack’s iterator until dispose + port-free. If the only text equals the prompt, persist nothing. File this against TanStack if a later adapter release still ends on `prompt()` instead of idle.
