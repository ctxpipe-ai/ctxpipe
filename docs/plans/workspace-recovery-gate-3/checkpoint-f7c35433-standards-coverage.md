# Gate 3 final correction — Standards coverage

## Identity and method

- Repository: `/private/tmp/ctxpipe-recovery-01a07aba`
- Reused cumulative review: `bb24210c01e0dc1bcbc2d4fdf197d07a7a17035d...d3ba7e591ecb557ca1e5c3da96ec9e99d0dd1f67`
- Focused pin: `f7c354334bb91310f3a49f74563bce6497c688ca`; merge base with `842e41bdeb68fc796d8a810a1dc17ccbf0d448e8` verified. One commit, 14 paths, +347/-12.
- Read-only pinned `git show`, `git diff`, and caller search. No implementation or test process ran; no broad rediscovery.

## Standards and retained scope

- Reused root/backend `AGENTS.md`, code-review and TDD/mocking guidance, ADR-027/028/033, accepted recovery plan, ownership audit, and the complete cumulative interface/caller ledger.
- Tooling-enforced matters excluded. Nine prior Fowler judgments retained without re-investigation.

## Focused changed-surface ledger

- **Parser:** `layout.ts:53-65` changes only the no-front-matter result from stripped input to `raw`. BOM stripping remains for delimiter recognition, so BOM-prefixed YAML front matter parses as before. Attribute parsing and malformed branches are unchanged.
- **Authority guard:** `extraction-source.ts:98-129` compares `before`/`after` raw plain bodies after the parser change. Its exact-content fast path, absent/created/deleted checks, claims-only metadata exclusion, and non-claims deep comparison are unchanged. Root and linked callers remain wired through `assertExtractionSource`.
- **Metadata writer:** `knowledge-metadata.ts:55-73` emits a new front matter block followed by the unchanged original raw plain body. The parser now represents that original plain body identically before and after the insertion.
- **Negative proof:** `write-extraction-admission-native.contract.test.ts:63-154` adds root BOM removal to the real Git candidate/broker matrix. The recorded red reached a push; green rejects, leaves the remote SHA fixed, and observes no contents-write token.
- **Positive proof:** `repository-extraction-native.contract.test.ts:37-42,329-347` seeds a BOM-prefixed plain root, executes the native repository producer/extraction owner, verifies claims publication, and compares the entire instruction suffix byte-for-byte.
- **Caller effects:** pinned search enumerated parser consumers in bootstrap, hydrate, maintenance, migration/export, rename, retraction, and source validation. Front-matter cases are unaffected. Plain bodies now retain their first byte, matching the parser’s byte-preserving body role; no durable schema, SQL, workflow, Git, or credential interface changed.
- **Evidence:** committed logs report 31/31 broker/parser/export cases and 1/1 positive native producer case. These were inspected, not rerun. Full candidate CI is pending and is not claimed here.

## Counts

- Documented-standard violations: **0**
- Blocking findings: **0**
- New Fowler judgments: **0**
- Retained Fowler backlog: **9** — Mysterious Name (2), Repeated Switches (1), Duplicated Code (6)
