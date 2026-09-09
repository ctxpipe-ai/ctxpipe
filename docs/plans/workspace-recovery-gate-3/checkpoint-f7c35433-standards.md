# Gate 3 final correction — Standards review

Pinned increment: `842e41bdeb68fc796d8a810a1dc17ccbf0d448e8...f7c354334bb91310f3a49f74563bce6497c688ca`. The cumulative `bb24210c...d3ba7e59` review and caller inventory were retained. CI is pending, so this report does not itself declare Gate 3 closed.

## Documented-standard violations

None.

The remaining root-authority blocker is closed. `parseSimpleFrontMatter` still removes a leading BOM to detect a front-matter delimiter, but when no delimiter exists it now returns the original raw string as the body (`apps/backend/src/domain/workspaces/layout.ts:53-65`). Consequently, `assertSourceClaimsOnly` compares a plain root’s BOM and all instruction bytes exactly (`apps/backend/src/domain/workspaces/extraction-source.ts:98-129`). A candidate that removes the BOM is rejected before write credentials/push, while `updateKnowledgeMetadata` can add claims front matter and retain the original BOM-prefixed body (`apps/backend/src/domain/workspaces/knowledge-metadata.ts:55-73`). This satisfies ADR-033:46 and :63.

The native broker regression is substantive: its red evidence reached an actual unsafe remote push, and the green case now keeps the remote tip unchanged and requests no write credential. The positive repository-producer case begins with a BOM-prefixed plain `AGENTS.md`, runs the typed extraction publication, and compares the complete post-front-matter body to the original bytes. The retained parser/export suite checks adjacent behavior; 31/31 focused cases and the positive producer case are recorded as passing.

The one-line parser change does not alter front-matter parsing, attributes, malformed detection, ownership, SQL scope, Git flow, or credential boundaries. Existing consumers either use attributes/malformed state or now receive the byte-preserving plain body promised by the shared parser contract.

## Fowler heuristics

No new judgment. Retained nonblocking backlog: **Mysterious Name (2), Repeated Switches (1), Duplicated Code (6)**.

**Counts:** 0 documented violations / 0 blockers; 9 retained nonblocking heuristics.
