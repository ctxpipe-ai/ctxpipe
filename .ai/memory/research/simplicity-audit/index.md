# Simplicity audit (adversarial review)

Research date: 2026-08-22

Scope: why this repo vendors a simplicity pass instead of installing [petekp/simplicity-audit](https://www.skills.sh/petekp/agent-skills/simplicity-audit) as-is. Implementation lives in [`.agents/skills/simplicity-audit/`](../../../../.agents/skills/simplicity-audit/SKILL.md). This note is prior art, not the skill.

## Question

How do we stop implementation agents from shipping leftover analogue machinery, and stop Sol reviews from blessing that machinery because the spec or ADR still names it?

## Evidence (Sol threads on this repo)

### Linear fold — brief supplied, leftover caught

[PR design review](https://cursor.com/agents/bc-194f5e2f-623e-4a82-9ee1-8cbf66915cd0). The user wrote the brief by hand:

> every step should receive adversary review by Sol. the reviewer should be well aware of the goal to simplify this implementation and not consider it correct

Sol then flagged leftover dual-writes, dead tables, and wizard-only DB persistence. The job collapsed to: tokens/binding on `connections.config`, draft/live scope as `linear/config.yaml` (PR branch vs target branch), webhook work via OpenWorkflow. Dropped: `linear_scopes`, `linear_sync_targets`, `linear_dirty_entities`.

### Notion fold — Confluence-shaped control plane

[System design simplification](https://cursor.com/agents/bc-68ed8145-ee4d-46f7-b809-b81d031171e0). Implementation worked; it had copied Confluence tables, scope dual-write, and full remirror. OpenWorkflow was already correct. The debt was extra Postgres control plane. Folded to the Linear thin model ([ADR-023](../../decisions/ADR-023-notion-connector-git-native-mirror.md)).

### Slack PR 267 — brief missing, leftover blessed

[PR 267 adversarial audit](https://cursor.com/agents/bc-8d06a0fa-f30b-4b99-80f2-383b60df1f58). Sol ran Standards, Spec, product grill, and security. Merge bar was tenancy/auth. Runtime leftover “mostly gone.” `slack_sync_targets` was never challenged: [ADR-025](../../decisions/ADR-025-slack-connector-git-native-mirror.md) still named it, so Spec treated the table as given ([Sol spec and product grill](https://cursor.com/agents/bc-1bad2fb9-05b0-56fc-b718-94a3fe1c03fb)).

A human later asked why Slack had a Confluence-shaped table. Linear and Notion already store that binding on `connections.config`. Five CREATE-then-DROP migrations were the feature’s autobiography, not a requirement.

### Source-connectors skill grill — next agent cargo-cults

[Sol round-2 skill grill](https://cursor.com/agents/bc-f7ba6b31-b6bf-5375-979e-e61d41f291fc). Same split applied to skill text: a vague or too-absolute rule makes the next connector invent tables, SaaS relays, or `config.yaml` theatre. Sol’s job was to break the skill before it shipped.

## What Standards + Spec cannot absorb

- **Spec** asks whether the diff matches the issue or ADR. That is how `slack_sync_targets` survived.
- **Standards** asks house style and Fowler smells. Speculative Generality does not ask “you copied Confluence; Linear is the sibling.”
- **Simplicity** asks whether the machinery should exist for this job. It may say the spec or ADR is overbuilt.

## Decision

Vendor the method (job → thinnest machine → essential vs accidental, justification search, confidence). Do not raw-install the upstream file (full-repo inventory, `docs/adr` paths, stack-rewrite posture).

Make the Linear brief unskippable: every `code-review` spawns a Sol Simplicity axis. ADRs are evidence, not a veto. Spec-match is not a defense.

## Sources

- [petekp simplicity-audit](https://github.com/petekp/agent-skills/blob/main/skills/simplicity-audit/SKILL.md) (MIT) — essential/accidental, justification search, confidence
- Linear / Notion / Slack Sol threads above
- [ADR-022](../../decisions/ADR-022-linear-connector-git-native-mirror.md), [ADR-023](../../decisions/ADR-023-notion-connector-git-native-mirror.md), [ADR-025](../../decisions/ADR-025-slack-connector-git-native-mirror.md)
