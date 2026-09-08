# Spec review — Gate 3 nine-kind checkpoint

Pinned range: `bb24210c01e0dc1bcbc2d4fdf197d07a7a17035d...10039ec00185b12c30aba616f6624a0abbd520f0`.

## Findings

1. **[P1] Rename repair excludes Markdown knowledge outside `knowledge/`.** `native-rename-rewrite.ts:46-50,103-112` builds candidates and editable sources only from `knowledge/**/*.md`; the workflow repeats that boundary at `workspace-rename-rewrite.ts:120-126`. Ticket 02:36 says “A markdown file (or an existing connector-mirror file) is a knowledge unit,” while ticket 10:103 skips only ambiguous, binary, and malformed cases. Root or connector renames leave stale references. Detect all hydrated Markdown units.

2. **[P1] Rename resolution disagrees with hydrate.** `native-rename-rewrite.ts:138-150` treats destinations beginning `knowledge/` or `/` as repository-rooted. Hydrate resolves every non-HTTP destination relative to its declaring directory (`hydrate.ts:214-229`). Ticket 03:42: “`to` is relative to the declaring file (same as markdown links).” Nested links can miss the renamed target or point elsewhere. Reuse the canonical resolver.

3. **[P2] Editing a moved document’s link label prevents repair.** `native-rename-rewrite.ts:170-177` requires the full surrounding syntax to uniquely match the old file. Changing `[Billing]` to `[Billing ledger]` while retaining stale `old.md` skips repair; duplicate identical links are also skipped. Ticket 02:60 says “repair as much as possible.” Match resolved destinations/occurrences, not presentation syntax.

4. **[P1] Migration turns omitted confidence into zero.** Existing claims read missing `confidence` as `undefined` (`migration-export.ts:400-438`), then coerce it to `0` (`604-607`). Hydrate previously used file/default confidence; zero suppresses the relationship. Ticket 03:42 says confidence is optional, and ticket 12:78 says merge keeps claim fields. Preserve absence.

5. **[P1] One malformed legacy linked URL aborts export.** `workspace-migration-export.ts:96-110` omits malformed source URLs but calls `linkedRepositoryUrlSchema.parse` for every linked row. One unsafe historical row rejects the durable step and blocks all knowledge. Ticket 02:45 says malformed declarations unlink for that SHA; ticket 12:9 requires no manual tenant migration. Filter malformed links and continue.

The six prior review defects, immutable rename command, Git 50%/ambiguity checks, binary/malformed skipping, no-op/replay, broker/push/hydrate ordering, and paused-to-queued ownership fix otherwise trace correctly. The declared planner/follow-up, three remaining kinds, caps, pause/conflict, alternate-writer, and deletion work remain open; this is not Gate 3 acceptance.
