# Gate 5 review A — BLOCK at `3fe0928d`

Fixed point: `cffcbc82`. Independent Sol review.

## Verdict

**BLOCK.**

## Blockers

1. File writes were concurrent; same-file order and unmount stale-retry were incomplete.
2. Routed 404 could reuse cached conversation detail.
3. Render-time title/phase repair remains in `WorkspaceChatSession` / `WorkspaceSurface`.
4. Missing-sandbox / untracked-read failures could become empty/plausible state.
5. Several required plays still did not prove their names (late error, every-socket
   cleanup, rapid routes, out-of-order final version, stable budget chat/diff,
   Pierre keyboard navigation).

Later commits on this branch address 1, 2, 4 (untracked read), and parts of 5.
Render-time repair and some play-name gaps remain.

## SHA reviewed

`3fe0928df798a330d1630d11256db2ba1829880c`
