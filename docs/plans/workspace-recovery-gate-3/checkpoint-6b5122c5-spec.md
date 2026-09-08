# Spec review — Gate 3 semantic handoff checkpoint

Pinned range: `bb24210c01e0dc1bcbc2d4fdf197d07a7a17035d...6b5122c56dbd838e6e8b7395455f939acf1eb775`.

## Finding

1. **[P2] A non-fast-forward mirror records two completed jobs for the semantic child’s one commit.** Every mechanical parent waits for a child whose input uses a distinct `${parentJobId}:semantic` ID (`write-broker.ts:238-262`); the semantic workflow persists that ID as its own `semantic_merge` job (`workspace-semantic-merge.ts:111-127`). Afterward the mirror parent writes the child SHA into its own row and marks itself completed (`workspace-connector-mirror.ts:210-226`; `workspace-write-jobs.ts:232-245`). Thus one default-branch change has two completed typed-job results, and replay identifies the semantic commit as though the original mirror job published it. The locked protocol says “Non-FF: fail this job; enqueue one semantic-merge job” (`.ai/scratchpad/git-backed-projects/issues/10-ingest-to-git-write-protocol.md:101`; repeated at :150), while Gate 3 exits only when each change has “one typed job, one commit, and one durable result” (`workspace-chat-recovery.md:653-654`). Mark the parent failed/superseded once the durable child is admitted and let only the child own its commit; preserve any export-cutover correlation as explicit metadata rather than a second completed commit result. Add parent/child terminal-status and unique commit-owner assertions.

The two prior findings are fixed: conflict paths join the validation allowlist and resolved unchanged trees become no-ops; unset provider selection now probes Docker with a deadline and falls back locally. Handoff captures the candidate’s exact binary-safe delta, refreshes the binding, retains mirror identity/managed paths, and lets the child own push/hydrate. Migration-export’s handoff no-op clears its unpublished candidate, records cutover at the refreshed tip, and enqueues hydrate.

The known path-history fold and declared Railway/sbx, post-admission/repeated semantic races, cleanup/restart, planner/caps, pause/protection, provider caller/alternate-writer migration, and legacy deletion remain open. This is not Gate 3 acceptance.
