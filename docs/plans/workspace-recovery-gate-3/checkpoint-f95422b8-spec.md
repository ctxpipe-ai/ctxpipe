# Spec review — G3-C/E runtime milestone (`f95422b8`)

No blocking Spec findings.

The prior G3-C defect is closed. After adopting a competing human root, `workspace-bootstrap.ts:190-200` now durably admits hydration before entering the ordinary transform/no-op path. The native case waits for `activeProjectionSha` to equal that real commit before replay, so completed replay can no longer bypass the only activation opportunity. This satisfies ticket 09’s “Hydrate the workspace tree **as-is**” and first-successful-SHA serving rules (`09-project-repository-lifecycle.md:89-93`).

The G3-E proofs exercise the claimed native boundaries. The allocation case forwards Docker’s real create request, withholds its successful reply, observes the real named container, kills the worker, and verifies two replacement processes reuse the same container ID. The model case kills the worker with the real model client awaiting its first HTTP response and observes one replacement request. Both assert the merged human/job result, one job commit, one write credential, resource destruction, and completion of the independently scheduled cleanup. These cover Gate 3’s required concurrent/retry idempotency and resource-state assertions (`workspace-chat-recovery.md:451-452,649-650`) without replacing owned runtime components.

Bun 1.4.2 is consistently enforced by the root engine, prerequisite check, both CI installations, and every Bun production image. The CI change does not weaken coverage: backend tests are the discovered inventory minus the required-contract set; contracts are exactly that set. Required-path existence and nonempty selection still fail closed, execution still runs prerequisites, allowlist history, Vitest, and strict report/inventory checks, and the contract baseline remains zero failures. `--list` only emits the partition. The 1,200-second contract timeout remains bounded and covers the measured resource-expiry proof.

G3-F and later work were excluded; this is not Gate 3 acceptance.
