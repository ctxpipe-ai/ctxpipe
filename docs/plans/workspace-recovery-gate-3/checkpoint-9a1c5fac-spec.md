# Spec review — G3-A/B milestone `9a1c5fac`

**Focused range:** `ec6d5340c4db91c4e888540deedddaa891ad9f58..9a1c5fac4fd6d8e2298a5fc25d8873239b22bcbf`

## Findings

No blocking Spec findings in the reviewed G3-A/B correction scope.

The prior connector wrong-version defect is closed. Connector prepare, activation, lost-ACK lookup, terminal projection, and bounded recovery now require namespace `default`, the exact typed workflow name, and null version (`connector-content-sync.ts:160-183,215-272,335-349,425-509`; `backfill-connector-content-admissions.ts:41-57`). Repository activation, current-owner lookup, progress admission, read projection, and migration backfill apply the same identity (`repository-ingestion-requests.ts:18-27,101-134,176-188`; `repository-ingestion-owners.ts:18-32`; `backfill-repository-ingestion-requests.ts:13-23`). This satisfies ADR-033:18: **“Native idempotency is name/key scoped; admission rejects a returned run from another version.”** The obsolete direct connector activation/retry helpers and their callers are removed; focused contracts now use native admission.

Persisted semantic handoff replay is also correct. When the handoff row already exists after a lost SQL reply, `persistSemanticHandoff` verifies the same owner, candidate, files, and deletions and returns the first persisted revision (`workspace-write-jobs.ts:410-467`). `captureSemanticHandoff` builds the child solely from that returned record (`write-broker.ts:354-395`), so a second human tip does not mutate the admitted delta; the semantic child performs subsequent reconciliation. This matches ADR-033:17: **“A further native compare-and-swap race releases only the exact unpublished candidate, refreshes the revision and retries the merge … preserving one original job/result identity.”**

Pre-upgrade paused jobs adopt their stored `desiredSha` when no payload revision/owner exists (`enqueue-workspace-write-commit.ts:201-229`). The actual retry scheduler supplies that same row SHA (`write-job-intent.ts:180-221`), after which normal broker reconciliation handles later tips, consistent with ADR-033:24: **“A paused command retains its captured tree when the same binding advances.”**

G3-C–G remain pending exactly as listed in `remaining.md`; this report does not treat them as milestone regressions or Gate 3 acceptance.
