# Gate 3 retraction checkpoint — Standards review

Pinned range: `bb24210c01e0dc1bcbc2d4fdf197d07a7a17035d...c869ba820ad722a3c5936568a69d02baa1546bb9`

## Documented-standard violation (1)

**[P1] Canonical claim sources do not round-trip every accepted repository path.** `plan-extraction.ts:71-80` appends `claim.sourcePath` directly after `#`, while `retract-extraction.ts:21-28` parses an existing source with `source.split("#")` and keeps only the first fragment. `repositoryFilePathSchema` permits `#` (`services/git/file-change.ts:3-19`), so a captured path such as `src/a#b.ts` is written as `repo.git#src/a#b.ts`, read back as `src/a`, and fails the current assertion key. Full retraction can then expire a claim that this capture actually reasserted. This violates ADR-033:43’s guarantees that concrete provenance becomes a canonical source link and expired captured claims are reasserted. Store repository URL and path as a typed pair, or use a reversible encoding/parser, and add native round-trip proof for an accepted reserved-character path.

The root ceiling is applied before durable fan-out, two roots run per batch, cumulative output is checked after each batch, and the native 129-root replay fails without a Git write. Retraction otherwise preserves unrelated evidence, owner metadata/prose, control files, and all connector trees including Slack.

## Fowler heuristic judgments (7; non-blocking)

The cumulative judgments remain: **Mysterious Name (2)** (`sourceId`→`evidenceKey`; dual-purpose `contentSyncWorkflowRunId`), **Repeated Switches (1)** in connector lifecycle dispatch, and **Duplicated Code (4)** across typed write admission, connector admission, GitHub credential issuance, and conversation preparation/publication. No new smell was added by this increment; its retraction transform is cohesive and the bounds are explicit domain schemas.

**Blockers: 1.**
