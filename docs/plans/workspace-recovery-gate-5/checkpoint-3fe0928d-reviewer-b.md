# Gate 5 review B — BLOCK at `3fe0928d`

Fixed point: `cffcbc82`. Independent Sol review.

## Verdict

**BLOCK.**

## Blockers

1. Routed 404s could reuse cached conversation detail.
2. File writes started before the queue chain; one CAS retry could be exhausted.
   Unmount flush bypassed stale retry.
3. `conversationWorktreeVersion` hashed empty content when an untracked read failed.
4. `OutOfOrderSaves` did not assert final authoritative version.
5. `StableRequestBudget` did not require chat or diff request counts.

Later commits on this branch address these production blockers and tighten the
two plays. Re-review is required before `CLOSE_GATE_5`.

## SHA reviewed

`3fe0928df798a330d1630d11256db2ba1829880c`
