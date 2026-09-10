# Gate 5 review B — BLOCK at `27135617`

Fixed point: `cffcbc82`. Independent Sol re-review.

## Verdict

**BLOCK.**

## Blockers

1. First-message retries can stream twice. After collection POST returns `x-conversation-id` but body consumption fails, both composers retry through item POST. That route ignores the retained idempotency key and stored turns, then starts another stream.
2. `WorkspaceChatSession` still exposes `composing` and retains a second `useChat` compose/send implementation, with story and test callers. Production compose correctly uses collection POST and navigation, but the competing owner remains.
3. `WorkspaceChatSession` still performs render-time identity repair by calling state setters when `title` or `conversationId` changes, despite the routed session being keyed by canonical conversation identity.
4. File-write snapshots update tree, status, and blob caches but neither update nor invalidate the conversation-diff cache. An already-loaded Diff can remain stale after a successful edit.
5. `PierreKeyboardFocus` manufactures its result by focusing and clicking the selected billing row before asserting focus, and may pass from `data-item-focused`. It does not prove the keyboard interaction itself leaves actual focus on that row.

## SHA reviewed

`27135617923ffe8ddfe35f4e7fa8b1c2232235b2`
