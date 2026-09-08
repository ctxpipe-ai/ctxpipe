# Gate 3 publication checkpoint — Spec review

**Pinned range:** `bb24210c01e0dc1bcbc2d4fdf197d07a7a17035d...c293853e9d062b2cf23c5d89805ebc9c7737bdcd`
**Decision:** pass for implemented scope — 0 findings.

## Findings

No actionable Spec defects found in the implemented checkpoint.

## Reviewed conclusions

The prior Slack P1 is resolved. The parent catches the child await only to query the owning native workflow-step projection; it rethrows suspension/nonterminal control flow, converts a recorded terminal child failure to a failed outcome, publishes the terminal status, and verifies `chat.update` fallback with a real failed-child run. This satisfies ADR-025 line 17: **“Status always terminates with a reason”**, without violating ADR-033 line 24’s prohibition on interpreting native suspension as failure.

Linear, Notion, and Confluence full-sync finalizers now carry the captured repository and branch and compare them under a locked row or atomic update predicate. The post-push rebind proofs show an old successful mirror cannot mark the replacement binding live. Notion token refresh now owns and commits its short org transaction before updating the connection directory; all production callers were adjusted.

Migration export records its knowledge paths before completion, atomically projects them with the completed result, and only then admits hydration for direct commits, ordinary no-ops, semantic commits, and semantic no-ops. An already-completed replay still runs the idempotent hydration tail, recovering the completion/enqueue crash boundary. This implements ADR-033 lines 15 and 17: completion **“atomically merges assignment metadata”** and the export parent runs its hydration tail on replay.

The audit explicitly leaves full connector generation/config/provider finalization, setup-failure lifecycle, export follow-ups, alternate writers/providers, deletion, and Gates 4–6 open. Those were excluded; this is not Gate 3 acceptance.
