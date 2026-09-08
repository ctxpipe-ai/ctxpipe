# Gate 3 pinned Spec review — `ae2c1bed69cea1c6724b05d8ae1ce7a659465b42`

Range reviewed: `bb24210c01e0dc1bcbc2d4fdf197d07a7a17035d...ae2c1bed69cea1c6724b05d8ae1ce7a659465b42`, using only pinned blobs.

## Finding

**[P1] Canonical extraction accepts duplicate object identities and silently discards extracted fields.** ADR-033:30 requires a “validated immutable extractor batch,” and ticket 10:68 says “The workspace repository is canonical.” Yet `extraction.ts:10-20` accepts repeated `deduplicationKey` values. That is a real extractor shape, not merely hostile input: the current ingest path deliberately collapses duplicate keys and merges their payloads (`retrievalObjectWrite.ts:120-140`; exercised at `retrievalObjectWrite.test.ts:78-107`). The native workflow instead maps every object directly (`workspace-extract-ingest.ts:145-168`). `planKnowledgeProjection` keeps both entries but keys path/title/body state by their shared ID (`migration-export.ts:458-469,492-560`), so the later entry overwrites the earlier state. Both entries then render to the later path (`:599-637`), and `stageGitFiles` applies duplicate paths sequentially (`write-tree.ts:33-51`). A batch containing complementary observations for one key therefore commits only the later payload; it can also allocate a discarded collision path. Canonicalize with the established encounter-order merge before persisting/admitting the immutable command, or reject duplicate keys and prove the producer performs that merge.

## Verified corrections

The prior config findings are closed: lifecycle reads apply provider defaults; proposal keys use canonical Linear/Notion/Confluence selections; failed Notion/Confluence finalization schedules a separate durable stale-PR close; disabled Confluence saves do not enqueue a proposal. The earlier claim that Confluence CAS loss could silently complete remains withdrawn.

No tests were rerun, as requested. Producer handoff, retraction, endpoint mapping, bounds, legacy recovery, and the other items named OPEN in `status.md:482` / `write-path-audit.md:38-40` remain acceptance scope rather than checkpoint findings.
