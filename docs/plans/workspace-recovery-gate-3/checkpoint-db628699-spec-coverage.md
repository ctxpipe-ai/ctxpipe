# Gate 3 Linear-native checkpoint — Spec coverage ledger

## Pin and governing contracts

- Reviewed exact `bb24210c01e0dc1bcbc2d4fdf197d07a7a17035d...db628699f5b15a7fba03589fbfbe7746b54a723e`; enumerated all 16 commits and the complete changed-file surface. Product reads used `git show db628699...:<path>` or pinned diffs, never the moving worktree.
- Applied the repository code-review skill's Spec axis, root/backend `AGENTS.md`, and the source-connectors review instructions. Read recovery-plan Gate 3 lines 642–659; locked ticket 10 lines 39–132; ticket 12 migration constraints; workspace identity ticket 18; ADR-022; ADR-033; pinned status and write-path audit.

## Prior finding: read-only no-op

- Traced `refreshWorkspaceWriteRevision` through all twelve typed workflows. It now resolves the actual default, compares the complete workspace binding, rereads revision/write status atomically, and compares the live revision while deliberately omitting `writeStatus === writable`. It never requests a write credential. Prior P1 is resolved.
- Reviewed the committed real-Git/PostgreSQL interleaving evidence that holds a file read, revokes write access, and completes `no_changes` with unchanged Git and zero write-token issuance.

## Rename planning and execution

- Traced active-projection selection and same-binding previous-SHA capture in `workspace-hydrate`; raw current Markdown capture; native current/previous pack acquisition; Git 50% similarity, ambiguity, binary/malformed filtering; requirement construction; reservation and deterministic replay.
- Traced `previousSha` through `workspace-write-planning`, paused-row reconstruction, typed enqueue schema, immutable job claim, acquisition of both SHAs, transform/stage/validation, no-op refresh, broker/semantic handoff, publication and hydrate.
- Checked `readGitPackFromRemote` callers and pack/shallow restoration. The new planner proof covers one human rename, replay deduplication, read-only planning and no push; retained native rename suites cover moved-source convergence and safety cases.

## Linear parent-to-child boundary

- Traced callers from config workflow, config-push webhook, manual retry route, and signed Linear webhook into full/entity parents. Traced the renamed capture-only service functions; no production references to removed `syncLinear*ToGit` functions remain.
- Verified durable target output contains workspace revision, mirror identity, paths and config only. Decrypted connection tokens are loaded inside provider steps; refresh performs network I/O outside SQL; files/deletes and non-secret failures cross the step boundary. The typed native child remains the sole workspace-write job/commit owner and enqueues canonical hydrate.
- Traced connector source/path validation, binding rechecks at acquisition and broker push, native no-op, semantic race handoff, one-commit publication, and replay ownership.
- Found the config-revision fence gap: neither `ConnectorMirrorSource` nor the child input carries the captured config blob/SHA, and binding validation observes only mutable connection/repository/branch/phase. A later config on the same binding is therefore indistinguishable from unrelated tip advancement. Existing native proof uses one config revision and cannot expose reversed completion.
- Reviewed retained legacy repository-ingestion and setup finalization calls as declared transition/open scope, not new findings.

## Evidence and declared open scope

- Inspected committed native proof logs/status, backend 141-diagnostic baseline, proof-policy/format checks, and the CI budget-only change; did not rerun heavy suites.
- Excluded acknowledged Notion/Slack/Confluence migration, setup-failure/finalization races, export/extraction planning and legacy removal, empty-repository initialization, conversation/config-PR broker guards, provider/topology completion, alternate-writer deletion, and Gates 4–6.
