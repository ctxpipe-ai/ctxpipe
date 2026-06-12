# Storage Architecture Decision

You are designing storage for a new observability subsystem in a large engineering organization.

This workspace contains a pinned checkout of one repository at `/app`.

Choose the best storage option and justify the decision with concrete code evidence.

Write `/app/answer.json` with exactly these keys:
- `selected_option`
- `alternatives_considered`
- `evidence`
- `decision_summary`

Rules:
- `selected_option` must be one of: `object_storage`, `block_storage`, `local_disk`.
- `alternatives_considered` must be an array of at least two options from the same set, excluding `selected_option`.
- `evidence` must be an array with at least 4 entries.
- Each `evidence` entry must be an object with keys:
  - `repo` (string)
  - `path` (string, repository-relative)
  - `claim` (string)
  - `supports_option` (boolean)
- `decision_summary` must be a concise technical rationale grounded in the evidence.

Use only factual evidence you can substantiate from available engineering context.
