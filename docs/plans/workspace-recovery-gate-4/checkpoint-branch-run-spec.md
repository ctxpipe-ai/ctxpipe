# Gate 4 owner-fix final Spec review

**Findings: 0.**

The explicit fetch refspec now records the restored session branch at `refs/remotes/origin/<session>`, so status can compare the actual session HEAD to its remote and truthfully return `published: true`. A deleted remote ref still produces the default branch without recreating the session ref and necessarily reports unpublished.

The full correction remains coherent: prepare does not mutate persisted branch metadata; current branch comes from native Git; the status schema and UI type carry it; missing status clears it; status/diff use the captured default; and commit authorization reads HEAD lazily from the per-turn stock `SandboxCapability`. The two original ownership findings and the prepare/publication race are closed. No new issue found in this narrow correction.
