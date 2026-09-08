# Gate 3 all-connectors checkpoint — Spec review

**Pinned range:** `bb24210c01e0dc1bcbc2d4fdf197d07a7a17035d...6bae4242686cc2438a3ac0fa326ca44e748f0b7d`  
**Decision:** fail for implemented scope — 1 high-priority finding.

## Finding

**[P1] A terminal native mirror failure leaves Slack permanently showing “working” — `apps/backend/src/openworkflow/workflows/slack-mention-agent.ts:79-161`.** After posting the working message, the capture branch awaits `step.runWorkflow` at lines 119–131. Any terminal schema, stale-scope, binding, validation, semantic-resolution, or publication failure escapes before `publish-capture-status` at lines 150–159. The webhook only reports enqueue failure (`apps/backend/src/routes/webhooks/slack/slack.ts:167-205`), so it cannot repair a run that was admitted and later failed. ADR-025 line 17 requires **“Status always terminates with a reason”** and specifically requires a fallback reply when updating the working message fails. The deleted parent test covered “updates status even when the agent throws”; its native replacement covers only bare success, model-intent success, and capability response (`slack-mirror-native.contract.test.ts:13-219`). Restore terminal failure publication through native terminal-state/finalizer semantics that do not catch OpenWorkflow suspension as failure, and add a real failed-child proof.

## Reviewed scope

The prior config-identity P1 is resolved: commands require the captured config blob SHA (or `null` absence), and acquisition, no-op refresh, semantic handoff, and broker admission reject stale scope before publication. Notion, Confluence, and Slack persist only content/non-secret metadata; provider tokens remain inside capture/status steps. Confluence suppresses orphan deletion on page failure and confines space-event deletion to that space. Slack’s model tool selects intent only, deterministic capture is separate, successful status follows child completion, and the working message is excluded. Declared connector lifecycle/finalization work, remaining alternate writers/planners/providers, deletion, and Gates 4–6 were excluded; this is not Gate 3 acceptance.
