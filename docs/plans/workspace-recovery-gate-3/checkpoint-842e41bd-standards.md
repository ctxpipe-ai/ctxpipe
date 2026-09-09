# Gate 3 correction — Standards review

Pinned increment: `d3ba7e591ecb557ca1e5c3da96ec9e99d0dd1f67...842e41bdeb68fc796d8a810a1dc17ccbf0d448e8`. The cumulative `bb24210c...d3ba7e59` coverage was reused. CI remains pending, so Gate 3 is not declared closed.

## Documented-standard violation

1. **[P1, blocker] The root claims-only guard is not byte-exact for a BOM-prefixed plain `AGENTS.md`.** The shared guard correctly compares parent and candidate at `apps/backend/src/domain/workspaces/extraction-source.ts:98-129`, but it obtains both bodies through `parseSimpleFrontMatter`. For a file without front matter, that parser removes the leading BOM and returns the stripped value (`apps/backend/src/domain/workspaces/layout.ts:53-60`). A semantic candidate can therefore add or remove that byte and pass. More directly, the corrected metadata writer preserves a plain file exactly by placing its raw bytes after the new front matter (`apps/backend/src/domain/workspaces/knowledge-metadata.ts:60-73`); for a BOM-prefixed file, the parent parser drops the BOM while the new candidate parser retains it inside the body, so a legitimate claims-only write is rejected. ADR-033:46 and :63 require unchanged instruction-body bytes. Compare a raw, delimiter-aware body slice that retains the BOM, and add a native broker case for a BOM-prefixed plain root.

## Verified corrections

The original root authority gap is otherwise closed. Own-workspace extraction now calls the shared guard (`extraction-source.ts:62-69`); linked source path/blob checks remain in front of it (`:71-95`). Acquisition, no-op refresh, and broker checks before write credentials and immediately before push all call `assertExtractionSource`, so semantic output reaches the same fence. The new native cases cover root body, non-claims metadata, and deletion, and assert no write credential or remote movement.

The four removed model APIs have no pinned production or test caller. Their removal leaves typed command persistence as the only write-job admission owner and does not expand SQL transaction scope. The `updateKnowledgeMetadata` change fixes the reproduced extra-newline defect for ordinary plain roots.

## Fowler heuristics

No new judgment. Retained nonblocking backlog: **Mysterious Name (2), Repeated Switches (1), Duplicated Code (6)**.

**Counts:** 1 documented violation / 1 blocker; 9 retained nonblocking heuristics.
