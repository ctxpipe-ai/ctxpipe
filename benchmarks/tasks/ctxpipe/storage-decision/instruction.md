# Grafana Storage Architecture Decision

You are designing storage for a new observability subsystem at Grafana.

The workspace contains a sparse, pinned checkout of the **primary repository**
`grafana/loki` at `/app`. It includes only a subset of files from that repo.

Your decision should also draw on patterns from related Grafana observability
repositories in the same organization:

- `grafana/loki` (primary — local checkout at `/app`)
- `grafana/tempo` (sibling)
- `grafana/mimir` (sibling)

Choose the best storage option and justify the decision with concrete code evidence
across these repositories.

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
  - `repo` (string — use `owner/repo` form, e.g. `grafana/loki`)
  - `path` (string, repository-relative)
  - `claim` (string)
  - `supports_option` (boolean)
- `decision_summary` must be a concise technical rationale grounded in the evidence.

Use only factual evidence you can substantiate from available engineering context.
