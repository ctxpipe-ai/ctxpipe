---
name: preview-env-chat
description: Multi-turn Workspace chat on a Railway PR preview.
disable-model-invocation: true
---

# preview-env chat

Stock TanStack `useChat` + websocket. Needs hydrate `ready`, a warm worker, and the model proxy. [Harness](../harness.md) is `PASS`. One `computerUse` task.

Use a **real** question about this workspace’s repo (architecture, a named file, how a feature works). Do not paste a canned “what’s in this repo?” inventory prompt.

## 1. First turn

From **Home** composer or workspace compose, send turn 1. The URL must become `/{orgSlug}/ws/{workspaceSlug}/{conversationId}` with a `conv_…` (or product) id.

Wait until **Setting up sandbox** and **Thinking…** are gone. Assistant text is visible. Tool chips may appear (read/search/other).

**Done when:** a conversation id is in the URL, the user bubble is the turn-1 text, and the assistant bubble has at least one non-empty paragraph.

## 2. Second turn

Send a follow-up that is only sensible if turn 1 happened (refer to the assistant’s answer: “that file”, “the approach you named”, “open that symbol”). Stay on the **same** `{conversationId}`.

Wait for **Thinking…** to clear again. A second assistant bubble appears.

**Done when:** the path’s conversation id is unchanged and two assistant turns are on screen.

## 3. Resume

Click another SideNav conversation (or Home) then return to this thread. `POST …/conversations/{id}/prepare` may flash **Setting up sandbox**. Both prior turns are still in the transcript.

**Done when:** the same `{conversationId}` shows turn 1 and turn 2 after the remount.

## Status

- **PASS** — steps 1–3 met. SideNav label may change (auto-rename).
- **FAIL** — stream error, sandbox never leaves “Setting up”, empty assistant, or turn 2 created a new conversation id.
- **SKIP** — workspace missing, `hydrateStatus !== "ready"`, or write/chat blocked with an explicit prepare error (record the chip/JSON).

On FAIL, attach Railway logs: `opencode.chatStream` / `tanstack-workspace-chat` ([analyze-logs](../../analyze-logs/SKILL.md)). A conversation POST **200** only means the stream opened.
