# Gate 5 review A — BLOCK at `27135617`

Fixed point: `cffcbc82`. Independent Sol re-review.

## Verdict

**BLOCK.**

## Blockers

1. First-message retries can still stream twice: after a lost response body, the client retains the assigned ID and retries through `POST /conversations/:conversationId`, bypassing the collection route’s stored-turn idempotency check.
2. `WorkspaceChatSession` retains render-time conversation/title state repair and an obsolete `composing` path alongside production `WorkspaceComposeChat`, so compose and route identity still have parallel implementations.

## SHA reviewed

`27135617923ffe8ddfe35f4e7fa8b1c2232235b2`
