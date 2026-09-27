# Area audit

Load only when the user asked to simplify an area (not on a diff review).

## Stance

Same classifications and justification search as [REVIEW-BRIEF.md](REVIEW-BRIEF.md). Same rule: the current shape and the ADR are evidence, not a veto. Load [REPO.md](REPO.md) when in this repo.

## Scope

A named app or area. Full monorepo only if the user said so. Explore with `cursor-grok-4.6-high-fast` sub-agents.

## Steps

1. **Memory first.** [`memory-search`](../memory-search/SKILL.md) + [`.ai/agents/domain.md`](../../../.ai/agents/domain.md) — product-context, glossary, `decisions/index.md`, lessons. Use glossary terms in the report.
2. **Name the job** the area actually does for a user. Then the **thinnest machine** (first principles + the aligned sibling).
3. **Inventory** feature areas against that machine — behaviors, files, tables, queues, phase machines, dual-writes. Rough LOC/file counts are enough.
4. **Classify** every control-plane piece (Essential / Earned / Accidental / Legacy / Uncertain) after the justification search. Stack ADRs stay out of scope unless the user reopened them.
5. **Propose** a collapse only for Accidental or Legacy. Each proposal: what exists, what it could be, gain, loss, what you verified, confidence.
6. **Write** `.ai/scratchpad/<area>/simplicity-audit.md`.

**Done when:** every control-plane piece in scope is classified, Accidental/Legacy proposals have a verification list, and the scratchpad file exists.

## After the report

Do not implement. Offer, in order: `/grilling` for Uncertain or high-impact proposals; `/to-tickets` for High+Accidental/Legacy; `/wayfinder` if the destination is multi-session; `/capture-adr` when the user rejects a finding for a load-bearing reason.
