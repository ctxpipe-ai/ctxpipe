---
name: review-pr
description: Review pull requests and staged changes before merge. Focuses on silent errors, unexpected behavior, and non-obvious bugs. Use when the user asks to review a PR, diff, or changes before merging into main. Does not propose major architectural changes.
---

# Review PR

Review pull requests and changes before merging into main. Focus on issues that can cause silent errors, unexpected behavior, or non-obvious bugs. Do not propose major architectural changes—the main structure is accepted.

## When to Use

- User asks to review a PR, diff, or changes before merge
- User asks "what should we fix before merging?"
- User wants a pre-merge review of their branch

## Workflow

### 1. Get the diff

```bash
git diff main...HEAD
```

For uncommitted changes:

```bash
git diff main
```

### 2. Overview

Summarize:

- Changed files and scope
- Apparent intent of the changes
- High-risk areas: auth, DB, external APIs, concurrency

### 3. Gradual analysis

Walk through the diff and check each category below. Flag issues with file:line references.

### 4. Improvement plan

Produce a structured plan with prioritized, actionable items (see Output format).

## Review Focus

**In scope:** Silent errors, unexpected behavior, non-obvious bugs, edge cases, data integrity, security gaps, async/race issues.

**Out of scope:** Major refactors, new patterns, structural changes to the codebase.

## Bug Categories Checklist

| Category            | What to look for                                                                     |
| ------------------- | ------------------------------------------------------------------------------------ |
| **Silent failures** | Swallowed errors, `catch` without rethrow/log, missing error handling in async flows |
| **Null/undefined**  | Optional chaining gaps, `?.` vs `.` misuse, unguarded access after nullable checks   |
| **Async/race**      | Missing `await`, parallel vs sequential ordering, stale closures                     |
| **Data integrity**  | Schema/validation mismatches, missing Zod/validation, type coercion risks            |
| **Auth/security**   | Missing auth checks, IDOR risks, injection (SQL, XSS)                                |
| **Edge cases**      | Empty arrays, zero, empty string, boundary conditions                                |
| **Conventions**     | Project rules from root and app AGENTS.md (e.g. "avoid pulling to globals")          |

## Project Context

- Read root AGENTS.md and relevant app AGENTS.md (e.g. `apps/backend/AGENTS.md`) for conventions.
- When changes touch architecture, reference ADRs in `.ai/memory/decisions/`—do not propose new ADRs or structural changes.

## Output Format

```markdown
# PR Review: [branch/scope]

## Summary

[1–2 sentences on scope and risk level]

## Improvement Plan

### Critical (fix before merge)

- [ ] [Issue] — [file:line] — [suggestion]

### Should fix

- [ ] ...

### Consider

- [ ] ...
```
