# Gate 5 review A — BLOCK at `8ef8b985`

Fixed point: `cffcbc82`. Independent Sol re-review.

## Verdict

**BLOCK.** Do not write `CLOSE_GATE_5`.

## Blockers

1. Home still generates `conversationId`; retries are not idempotent; POST
   returns no canonical identity.
2. Cross-path writes still share one worktree CAS with one retry; unmount
   flush is not joined to the per-path queue map.
3. Required plays still overclaim (out-of-order final body, every-socket
   cleanup, first-message then late error).
4. `workspaceChatWebSocket.test.ts` typecheck failure on `readyState`.

Required CAS, routed 404, dispose-all production logic, and hydrate error
propagation were accepted as corrected.

## SHA reviewed

`8ef8b985151c8113f4f29db3df5be833c1ec90c0`
