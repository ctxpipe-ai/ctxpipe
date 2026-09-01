---
name: simplicity-audit
description: >
  Essential vs accidental. Use when an adversarial review of a diff must name leftover
  machinery; when asked to simplify an area; or when code-review or grilling needs a
  thinnest-machine judgment.
license: MIT
metadata:
  author: petekp (method); ctxpipe (review-first adaptation)
---

# Simplicity Audit

Name the **job**, name the **thinnest machine** that does it, then split the rest into **essential** vs **accidental**.

This is not a bug hunt and not a deepening pass. Spec-match is not a defense. Method adapted from [petekp/simplicity-audit](https://github.com/petekp/agent-skills/blob/main/skills/simplicity-audit/SKILL.md) (MIT).

In this repo, read [REPO.md](REPO.md) first.

## Pick a branch

- **Review** (default) — a pinned diff, or `code-review` asked for the Simplicity axis. Apply [REVIEW-BRIEF.md](REVIEW-BRIEF.md) to that diff.
- **Audit** — the user asked to simplify an area. Load [AUDIT.md](AUDIT.md).

## Review

1. Pin the diff (`git diff <fixed-point>...HEAD`) if `code-review` has not already.
2. Apply every rule in [REVIEW-BRIEF.md](REVIEW-BRIEF.md).
3. Report under `## Simplicity` when this run is part of `code-review`; otherwise use the brief’s report shape as the whole answer.

**Done when:** the brief’s completion criterion holds.

## Shared terms

**Essential** — the job requires it (HMAC on the raw body, OpenWorkflow instead of a custom queue, git as content SoT). Name it so nobody deletes it.

**Accidental** — leftover analogue, dual-write, ceremony, unused flexibility, facade after delete, migration autobiography.

A **hypothetical seam** (one adapter, no ADR) is often accidental. A deep module that does the job is essential — flattening it is the wrong fix. Vocabulary when needed: [`codebase-design`](../codebase-design/SKILL.md).
