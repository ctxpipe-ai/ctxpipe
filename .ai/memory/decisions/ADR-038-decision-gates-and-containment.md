# ADR-038: Decision gates and containment for AI decisions

**Status:** Proposed | **Date:** 2026-09-24 | **Tags:** advisor, mcp, decisions, memory, evaluation

Builds on [ADR-036](ADR-036-decision-scope-and-status.md) (decision status in the
graph; in #350, not yet merged) and
[ADR-037](ADR-037-committed-memory-reaches-the-graph.md) (lessons and
corrections). Proposed until the live evaluation below clears its bar.

## Context

A customer CTO asked how ctx| stops bad AI decisions compounding when, at scale,
reviewers click approve. Evidence gathered for this ADR:

- **Review does not happen.** Of the last 83 merged human-authored pull requests
  in this repository, 59 (71%) had no human review; 18 of the 33 over 1,000 lines
  merged unreviewed or silently approved. 45 of 96 recent commits carry an AI
  co-author trailer. Pull-request review cannot be the only gate.
- **The advisor manufactures standards.** Asked where to store operator secrets,
  production `ctx_advisor` said no ADR or instruction covered it, then
  recommended Railway variables and "Do not add 1Password or AWS Secrets
  Manager". An agent escalating to a human happened only when the calling agent
  chose to.
- **Popularity reads as approval.** The advisor was told "if many services use
  Postgres, that's the recommendation", so AI-copied patterns count as consensus.
- **The keyword retrieval channel is near-silent** for agent prompts (all-terms
  match: 1 object for "Which graph database should a new service use, and
  why?"); semantic search carries retrieval.

## Decision

1. **Advisor reasoning.** Usage describes practice, not approval: an accepted
   decision or rule outranks any number of usages. A correction overrides advice,
   never an accepted decision; a conflict needs a human. With no accepted
   decision on a high-stakes choice, the advisor lays out options and does not
   present its pick as the standard.
2. **Decision gate on MCP answers** (`decisionGate.ts`). A deterministic check
   appends `**Human decision needed**` when a decision-shaped prompt in a
   high-stakes area (security, personal data, compliance, payments, data model,
   architecture, infrastructure) is not covered by an accepted decision or a
   human-maintained rule among the retrieved candidates; when the only on-topic
   decision is proposed; or when a correction meets an accepted decision.
3. **Escalation asks the person in the session first, and stays in Git.** The
   block tells the agent to stop and ask the user, with its recommendation and
   the options: the user decides now (recorded in the pull request description,
   or as an ADR noting who decided if it is lasting); or hands it to the owner as
   a proposed ADR (`Status: Proposed`) that nobody builds on yet; or explores
   further. A background run with no one to ask writes the proposed ADR. An ADR
   is one outcome, not a mandate: forcing one per escalation would breed
   unreviewed proposals. With ADR-036, proposed decisions weigh less than
   accepted ones at read time, and the gate never lets a proposed decision count
   as cover, so an agent's choice cannot become the org standard until a human
   accepts it. The local memory rule and `capture-adr` skill say the same.

## Evaluation (2026-09-24)

Deterministic eval (`decisionGate.eval.test.ts`) over the 35 real Decision
objects from production, with every decision offered as a candidate so the gate,
not retrieval, must find the cover:

| Set | Correct | Escalation precision | Escalation recall |
|---|---|---|---|
| Tuning (22, written with the code) | 22 | 1.00 | 1.00 |
| Held-out 1 (32, blind, first run) | 18 | 0.73 | 0.53 |
| Held-out 1 after fixing intent detection and summary matching (no longer blind) | 25 | 0.78 | 0.93 |
| Held-out 2 (30, blind, final) | 20 | 0.75 | 0.75 |

Stakes detection works; judging coverage by matching words does not generalize.
Blind failures: options read as the subject ("S3, R2, or Postgres" matched the
Postgres ADR), unknown products (NATS), synonyms ("tokens" vs "secrets"), name
collisions ("ReAct agents" matched React), and multi-area prompts matched on the
wrong area.

## Consequences

- The root design holds: escalation produces a proposed ADR in Git, status
  weighting keeps it out of the standard until accepted, and nothing bypasses
  review. The weak link is deciding whether something is already decided.
- At 0.75 precision, one escalation in four is noise; an always-on gate at that
  level recreates the approval fatigue it is meant to fix.
- **Bar before this ADR is accepted:** the live eval
  (`src/scripts/decisionGateLiveEval.ts`, real semantic retrieval on a preview
  deployment) reaches escalation precision ≥ 0.9 and recall ≥ 0.85 on the
  held-out sets. If lexical coverage cannot reach it, coverage moves to a
  semantic judgement: the advisor names the covering ADR, and code verifies it
  was retrieved and is accepted.
- Not covered: owner routing (CODEOWNERS → Team OWNS), weighting knowledge by
  review depth or AI authorship, a pull-request check for decision conflicts, and
  risk-sampled audits of merged AI decisions.

## Alternatives considered

- **Escalate on any ambiguity** — rejected: the escalation layer becomes another
  approval to click through.
- **Prompt-only escalation** — rejected as the only mechanism: an agent cannot
  rely on free-text judgement to stop; the block's presence must be dependable.
- **LLM-judged coverage now** — deferred: not measurable without a deployed model;
  the live eval decides between it and retrieval-based coverage.
