# Gate 5 review B — BLOCK at `832e77b8`

Fixed point: `cffcbc82`. Independent Sol re-review.

## Verdict

**BLOCK.** Do not write `CLOSE_GATE_5`.

## Blockers

1. Collection POST is not idempotent if streaming fails after acceptance;
   `res.text()` errors drop the header identity.
2. `WorkspaceSurface` still repairs chrome identity during render.
3. Cross-path CAS retries stop after eight attempts.
4. Save plays do not prove persisted dirty bodies / distinct out-of-order
   contents.
5. Late-error fake socket `readyState` fails UI typecheck (`TS2322`).

## SHA reviewed

`832e77b8cf6351dd297fbb48028c51c292992bba`
