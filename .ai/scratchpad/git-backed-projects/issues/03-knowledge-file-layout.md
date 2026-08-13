# Knowledge Markdown and front-matter layout

Type: grilling
Status: open
Blocked by: 02

## Question

What is the **on-disk layout** of git-backed knowledge in the project repository?

The brief: mostly markdown with front matter, including claims. Connector mirrors already own `notion/`, `linear/`, and Confluence managed trees. Extracted objects/claims have no git representation today.

Settle:

- Root directory and how it avoids colliding with connector trees and the customer's own docs.
- One file per claim, per object, or grouped files?
- Front-matter schema: stable ids, predicate, subject/object refs, status, confidence, evidence pointers, timestamps.
- Evidence: same file, sidecar, or pointers at source paths already in git?
- Human-editable: a person edits a claim file and pushes — next hydrate treats it as truth?
- Generated vs hand-written: a marker so ingest does not clobber human edits?
- Config that today lives in `connections.config` vs config files in git (already true for `notion/config.yaml` / `linear/config.yaml`).

Recommend the smallest layout that hydrates without an LLM and stays reviewable in a GitHub diff. Show two example files, not a 20-type taxonomy. This layout **blocks** migration and ingest — they cannot export or commit without it.
