# Gate 5 review A — BLOCK at `832e77b8`

Fixed point: `cffcbc82`. Independent Sol re-review.

## Verdict

**BLOCK.** Do not write `CLOSE_GATE_5`.

## Blockers

1. Collection POST is not idempotent if the first response is lost before
   `x-conversation-id` is received.
2. Cross-path CAS retries stop after eight attempts; `onMutate` and
   `mutationFn` can observe different versions.
3. `WorkspaceChatSession.stories.tsx` fake socket `readyState` fails UI
   typecheck (`TS2322`).
4. Required plays still overclaim (late-error uses composing session, not
   production compose; out-of-order records rejected bodies; Pierre focus
   can pass on the shadow host).
5. Missing-sandbox `409` can still become successful empty git status.

## SHA reviewed

`832e77b8cf6351dd297fbb48028c51c292992bba`
