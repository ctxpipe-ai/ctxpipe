# Final standards re-review — base transitions, cancellation, and image GC

Scope: WIP in `/private/tmp/ctxpipe-recovery-01a07aba` versus `40c6e8b08cc91d209bcc39bef59aa6d839e73f12`, including the listed untracked files. I reviewed only the legacy-owner and rewind closures, native Files cancellation additions, and persisted-image GC. I made no code edits and ran no tests.

## Documented blocking standards defects

None found in the bounded scope.

The prior legacy-owner blocker is closed: exact `get` remains exact, while transition discovery rejects a pre-upgrade null-key live owner and reports its retained native/provider IDs (`sandbox-instance-store.ts:20-26,53-97`; `tanstack-workspace-chat.ts:374-380`). This satisfies ADR-034:27.

The rewind blocker is closed: a matching `complete` marker alone enables replay, an unmarked initial rewind reaches `rebase --onto`, and a completed superseded target is used only as the next rebase base (`workspace-chat-revision-transition.ts:66-125`). The final record move checks the current workspace binding inside its short transaction and updates only the prior exact owner (`sandbox-instance-store.ts:99-158`), satisfying ADR-034:27,30 and backend `AGENTS.md`:11.

Files and push hold `chat-thread` across ensure and the full handler; request abort and lease loss share one controller, which reaches native exec and the optional native Fs signals (`conversation-files-routes.ts:397-425`; `job-sandbox.ts:20-50`). The ai-sandbox, Docker, and local-process patches carry matching source/runtime contract changes; Docker relative Fs paths resolve under its workdir. This satisfies ADR-034:30.

The nullable persisted image is written on upsert/move. Base collection recognizes a changed image before a replacement base exists, retains every persisted snapshot owner, and deletes the image only under the snapshot lock after the last owner is gone (`workspace-sandbox-cleanup.ts:20-80,97-157`; `workspace-sandboxes.ts:7-50,65-115`). Both schema migrations are generated artifacts, consistent with backend `AGENTS.md`:12 and ADR-034:28.

Native final checks remain running and are not claimed. Wider Gate 4 provider/security review, quoting audit, and TypeScript baseline cleanup remain pending outside this checkpoint.
