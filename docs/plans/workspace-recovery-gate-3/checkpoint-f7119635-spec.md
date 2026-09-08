# Gate 3 five-kind Spec review

Reviewed pinned `bb24210c01e0dc1bcbc2d4fdf197d07a7a17035d...f7119635da09e39f853e9b6c64770924538a3006`. This is an intermediate review of the five migrated kinds, not Gate 3 acceptance.

## Findings

1. **[P1] Claims upgrade removes the Layer-1 relationship from the next projection.** The locked schema says, “`predicate` missing ⇒ layer 1 only for that target” (`03-knowledge-file-layout.md:42`) and defines relative Markdown links as `LINKS_TO` (`02-hydration-contract.md:37`). The transform appends `{to}` without a predicate (`hydrate-write-jobs.ts:135-147`), while hydration skips that claim and also suppresses the Markdown fallback whenever any claim resolves to the same target (`hydrate.ts:156-193`). Thus the upgrade commit turns a visible `LINKS_TO` edge into no edge. Write `predicate: LINKS_TO`, or make predicate-less claims project the Layer-1 edge, and add a post-commit hydrate assertion.

2. **[P1] Claims and valid-from maintenance delete claim-owned metadata.** The schema explicitly permits `generated_by` and says it is a merge hint (`03-knowledge-file-layout.md:41-42`). Hydration parses only six fields (`hydrate.ts:251-268`); both transforms rebuild every claim from that lossy model and replace the whole YAML sequence (`hydrate-write-jobs.ts:98-123,141-147,172-184`). A repair to one claim therefore removes `generated_by`, unknown fields, tags/anchors, and claim-level comments from all claims in the file. Mutate YAML document nodes in place: append only new claims and set only the target `valid_from`; test `generated_by`, custom fields, and inline comments.

3. **[P2] Equivalent relative claim targets create a non-no-op commit and duplicate records.** The schema says `to` is file-relative “same as markdown links” (`03-knowledge-file-layout.md:42`), and the write protocol requires “No file changes → skip” (`10-ingest-to-git-write-protocol.md:77`). Remainder and transform compare raw strings (`hydrate-write-jobs.ts:13-16,135-143`), so `api.md` and `./api.md` are treated as different despite resolving to one target. Compare normalized resolved targets and deduplicate repeated links.

No further defect was found in the pinned command binding, native pack/mode handling, actual-default/relink fences, normal Git non-fast-forward behavior, descendant lost-ack recovery, hydrate enqueue-before-completion, or admission/terminal status corrections.
