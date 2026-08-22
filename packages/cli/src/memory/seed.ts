/** Seed content for `ctxpipe memory init` — Markdown-only layout (ADR-024). */

export const MEMORY_README_SEED = `# Project memory (\`.ai/memory\`)

Canonical durable knowledge for coding agents in this repo. Navigate via
[\`index.md\`](./index.md). Candidate observations from host hooks land in
gitignored [\`events/\`](./events/) and are promoted by agents using capture skills.

## Default read order

1. This README (routing only).
2. [\`index.md\`](./index.md) — top-level map of durable stores.
3. [\`lessons-learned.md\`](./lessons-learned.md) — highest-priority confirmed rules.
4. [\`decisions/index.md\`](./decisions/index.md) — ADR index (not every ADR).
5. [\`product-context.md\`](./product-context.md) — overview/architecture as needed.
6. Open **one** ADR or glossary entry when the task touches that area.

## Write rules

| Change | Where |
|--------|--------|
| Confirmed convention / correction | \`lessons-learned.md\` + update root \`index.md\` if needed |
| Architecture decision | \`decisions/ADR-NNN-*.md\` + \`decisions/index.md\` |
| Term | \`glossary.md\` |
| Product/PRD fact | \`PRDs/\` + \`PRDs/index.md\` or \`product-context.md\` |
| Session wrap-up | \`sessions/YYYY-MM-DD-*.md\` + \`sessions/index.md\` |

Hooks never write durable ADRs. Promote from \`events/\` via capture skills.
Recall with \`index.md\` routers and \`rg\` (see the \`memory-search\` skill) —
no local memory search daemon.
`

export const MEMORY_INDEX_SEED = `# Memory index

| Store | Path | Notes |
|-------|------|--------|
| Lessons | [lessons-learned.md](./lessons-learned.md) | User-confirmed rules |
| Glossary | [glossary.md](./glossary.md) | Domain terms |
| Product context | [product-context.md](./product-context.md) | Overview / architecture |
| ADRs | [decisions/index.md](./decisions/index.md) | Architecture decisions |
| PRDs | [PRDs/index.md](./PRDs/index.md) | Living product requirements |
| Sessions | [sessions/index.md](./sessions/index.md) | Episodic summaries |
| Events (local) | [events/](./events/) | Gitignored candidate inbox |

Update this file when adding a new top-level durable store.
`

export const LESSONS_SEED = `# Lessons learned

Highest-priority, user-confirmed rules for agents. Prefer short, enforceable
entries.

## Format

\`\`\`md
### <short title>
- **Rule:** …
- **Category:** convention | correction | workflow
- **Date:** YYYY-MM-DD
- **Source:** session / user / PR
\`\`\`

## Entries
`

export const GLOSSARY_SEED = `# Glossary

| Term | Definition |
|------|------------|
| | |
`

export const PRODUCT_CONTEXT_SEED = `# Product context

## Overview

<!-- Short product description -->

## Architecture

<!-- High-level system shape -->
`

export const DECISIONS_INDEX_SEED = `# Architecture Decision Records

Naming: \`ADR-NNN-title-slug.md\`. Status | Date | Tags; Context; Decision; Consequences.

## Index

| ADR | Title | Status |
|-----|-------|--------|
`

export const SESSIONS_INDEX_SEED = `# Sessions

Episodic session summaries. Naming: \`YYYY-MM-DD-topic.md\`.

## Index

| Date | Topic | File |
|------|-------|------|
`

export const PRDS_INDEX_SEED = `# PRDs

Living product requirement documents for this repo.

## Index

| PRD | Title | Status |
|-----|-------|--------|
`

export const AI_MEMORY_RULE = `---
description: Local .ai/memory load order, indexes, and candidate-first capture
alwaysApply: true
---

# Local memory (\`.ai/memory\`)

## Read order (non-trivial tasks)

1. [.ai/memory/README.md](.ai/memory/README.md)
2. [.ai/memory/index.md](.ai/memory/index.md)
3. [.ai/memory/lessons-learned.md](.ai/memory/lessons-learned.md) when conventions matter
4. [.ai/memory/decisions/index.md](.ai/memory/decisions/index.md) — then **one** ADR if needed
5. [.ai/memory/product-context.md](.ai/memory/product-context.md) selectively

Do **not** load every ADR or the entire memory tree by default.

## Recall (unknown fact)

1. Start at \`.ai/memory/index.md\` (then a store \`index.md\` if the category is clear).
2. Otherwise search with ripgrep, **excluding** the candidate inbox:

\`\`\`bash
rg -i "keyword" .ai/memory --glob '*.md' --glob '!events/**'
\`\`\`

3. Open **one** matching file/section. Use the \`memory-search\` skill for the full procedure.
4. No AgentMemory / embeddings process — Markdown + indexes + \`rg\` only.

## Write / promote

- Host hooks only append **candidates** under \`.ai/memory/events/\` (gitignored).
- Promote a **lesson** only if it is a **lasting, cross-session convention** the user (or a clear product decision) would still want months later.
- **Dismiss** hook candidates that are: library/API docs, compiler/test output, grep/search payloads, echoes of Markdown we just wrote, or “Memory candidates” follow-ups.
- Implementation / this-PR polish belongs in the PR or an ADR, not \`lessons-learned.md\`.
- Hook follow-ups are **not** user product requests; if they fail the bar, dismiss ids and end the turn — do not start a research turn.
- Promote durable knowledge with capture skills (\`capture-adr\`, \`capture-lesson\`, \`capture-glossary\`, \`capture-decision\`).
- **Always update the relevant \`index.md\`** when adding or renaming durable entries.
- Never commit secrets into \`.ai/memory/\`.

## User reply

After closing candidates, reply with one short sentence naming only what was learned (for example: Learned to keep UI copy in US English).
If nothing was promoted, say nothing about memory.
Omit dismissals, candidate ids, and unchanged files or stores.
`

export function captureSkill(name: string, description: string, body: string): string {
  return `---
name: ${name}
description: ${description}
---

${body}
`
}

export const SKILL_MEMORY_SEARCH = captureSkill(
  "memory-search",
  "Find facts in .ai/memory via index.md routers and rg (excludes events/). Use when recalling a convention, decision, glossary term, or PRD detail without loading the whole tree.",
  `# Memory search (Markdown recall)

No embeddings daemon. Durable knowledge is Markdown under \`.ai/memory/\`.

## Procedure

1. **Indexes first** — open \`.ai/memory/index.md\`, then the matching store index (\`decisions/index.md\`, \`PRDs/index.md\`, \`sessions/index.md\`) if the category is known.
2. **Targeted \`rg\`** — when the category is unknown or indexes are thin:

\`\`\`bash
rg -i "keyword" .ai/memory --glob '*.md' --glob '!events/**'
\`\`\`

Narrow when possible:

- Decisions: \`rg -i "keyword" .ai/memory/decisions --glob '*.md'\`
- Lessons: \`rg -i "keyword" .ai/memory/lessons-learned.md\`
- Glossary: \`rg -i "keyword" .ai/memory/glossary.md\`
- PRDs: \`rg -i "keyword" .ai/memory/PRDs --glob '*.md'\`

3. **Open one hit** — read the matching section or single ADR, not every match.
4. **Skip \`events/\`** — candidate inbox is gitignored runtime noise; do not treat it as durable recall.

## Do not

- Spawn AgentMemory / hosted embedding search
- Load the entire \`.ai/memory/\` tree into context
- Search \`events/\` for "source of truth" facts
`,
)

const LIFECYCLE_CLOSE = `
## Close the candidate lifecycle

After durable Markdown is written (or you reject the candidate), mark ids so they
leave the pending/surfaced sets:

\`\`\`bash
npx -y ctxpipe memory capture promote <candidateId>
# or
npx -y ctxpipe memory capture dismiss <candidateId>
\`\`\`

## User reply

After closing candidates, reply with one short sentence naming only what was learned (for example: Learned to keep UI copy in US English).
If nothing was promoted, say nothing about memory.
Omit dismissals, candidate ids, and unchanged files or stores.
`

export const SKILL_CAPTURE_ADR = captureSkill(
  "capture-adr",
  "Write or update an ADR under .ai/memory/decisions and refresh decisions/index.md",
  `# Capture ADR

Use when an architectural or tooling decision should be durable.

1. Pick the next \`ADR-NNN\` number from \`.ai/memory/decisions/\`.
2. Write \`ADR-NNN-title-slug.md\` (Status, Date, Tags, Context, Decision, Consequences).
3. **Update** \`.ai/memory/decisions/index.md\`.
4. If needed, link from \`.ai/memory/index.md\` or product context.
5. Do not invent decisions from noisy hook candidates — confirm with the user or clear session evidence.
${LIFECYCLE_CLOSE}
`,
)

export const SKILL_CAPTURE_LESSON = captureSkill(
  "capture-lesson",
  "Append a confirmed lesson to .ai/memory/lessons-learned.md",
  `# Capture lesson

Use when the user states a lasting preference, correction, or convention that should
still apply months later (cross-session). Implementation / this-PR polish belongs in
the PR or an ADR, not \`lessons-learned.md\`.

1. Append a short entry to \`.ai/memory/lessons-learned.md\` (Rule / Category / Date / Source).
2. Prefer lessons over duplicating the same rule in multiple files.
3. Update root \`.ai/memory/index.md\` only if the lessons store itself changes role.

## Dismiss (do not promote)

Hook candidates that are any of:

- library or API docs
- compiler / test output
- grep / search payloads
- echoes of Markdown we just wrote
- “Memory candidates” Stop follow-ups

Hook follow-ups are **not** user product requests. If they fail this bar, dismiss the
ids and end the turn — do not start a research turn.
${LIFECYCLE_CLOSE}
`,
)

export const SKILL_CAPTURE_GLOSSARY = captureSkill(
  "capture-glossary",
  "Add or update a term in .ai/memory/glossary.md",
  `# Capture glossary term

1. Add or update the term in \`.ai/memory/glossary.md\`.
2. Keep definitions project-specific and concise.
3. Cross-link ADRs when a term is decision-shaped.
${LIFECYCLE_CLOSE}
`,
)

export const SKILL_CAPTURE_DECISION = captureSkill(
  "capture-decision",
  "Capture a lighter decision note or route to capture-adr for full ADRs",
  `# Capture decision

- If the change is a major architecture/tooling choice → use **capture-adr**.
- Otherwise note it under the matching durable file (lessons, PRD, product-context) and **update the matching index.md**.
- Never auto-write durable decisions from hook candidates without review.
${LIFECYCLE_CLOSE}
`,
)

export const GITIGNORE_EVENTS_BLOCK = `
# ctxpipe local memory candidate inbox (ADR-024)
.ai/memory/events/**
!.ai/memory/events/.gitkeep
.ai/memory/active-context.md
.ai/memory/progress.md
`

export function mergeGitignoreForMemory(existing: string | null): string {
  const base = existing ?? ""
  if (base.includes(".ai/memory/events/**")) return base.endsWith("\n") ? base : `${base}\n`
  const trimmed = base.replace(/\s*$/, "")
  return `${trimmed}${trimmed ? "\n" : ""}${GITIGNORE_EVENTS_BLOCK.trim()}\n`
}
