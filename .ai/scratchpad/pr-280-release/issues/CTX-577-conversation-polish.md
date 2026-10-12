# CTX-577: conversation polish

- Header of the changed-files card uses `pl-2`, so Open diff aligns.
- `conversationCtaPlan` (conversationPublish.ts) holds the one-CTA rule. Unit table covers every state.
- Dark CTA face uses `zinc-200` instead of the near-white primary token.
- Scroll-to-bottom button has no border and a `muted` face.
- Push entry bug: the thread wrapped the card and the push entry in a flex row. The wrapper is now a column. The branch name truncates.
- Branch label has no tooltip, because the tooltip showed the internal ref.
- Stories: PushEntryUnderCard, SyncCtaWithSubtleShowPr, DirtyShowsOnlySync, PublishPrErrorToast (split from PublishErrorsToast).
- Golden run: one unrelated palette story failed once and a different one in an earlier run (flaky). `pnpm typecheck` fails on the base too (dependency types).
