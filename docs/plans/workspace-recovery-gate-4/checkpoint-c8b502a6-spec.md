# Gate 4 Spec correction review — `c8b502a6`

**Findings: 0 blocking, 0 nonblocking.**

The sole `0727d284` blocker is resolved. The accepted plan requires proof for “simultaneous sends” and “transcript equality” (`docs/plans/workspace-chat-recovery.md:676-678`), while ADR-034 requires submitted history to be validated under the native transcript lock before a model call (`.ai/memory/decisions/ADR-034-native-postgres-sandbox-ownership.md:23`). The package patch now acquires `chat-thread:${threadId}` during setup, then loads the current persisted transcript and compares it with the submitted historical prefix in `onConfig` while that lock remains held (`patches/@tanstack__ai-persistence@0.5.1.patch`, source-patch lines 270-288). A late stale request therefore cannot replace a transcript committed by the preceding owner. The retained native case also verifies rejection before any model request, unchanged persistence, and a successful retry from the native model→UI→wire representation (`workspace-chat-native.contract.test.ts:224-292`).

The omitted-message path correctly lets `withPersistence` load durable history before `openCodeTrailingUserMiddleware` appends the current prompt (`tanstack-workspace-chat.ts:336-353`). Rehydrating persisted top-level `createdAt` JSON strings as `Date` restores the native conversion contract without changing message content (`workspace-chat-persistence.ts:71-89`). Lock release remains in all terminal hooks; the existing cancellation retry continues to exercise release after abort.

Scope reviewed: `0727d284...c8b502a6` production/package patch, ADR update, and directly relevant native assertions. The untracked provider file and other Gate 4 milestones were excluded as requested. Test results were accepted as supplied; no suites were rerun.
