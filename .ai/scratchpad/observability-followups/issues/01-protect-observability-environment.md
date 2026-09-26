# Protect the observability GitHub environment

Status: ready-for-human

Create GitHub Environment `observability` with required reviewers and a `main`-only deployment branch policy before the observability apply workflow runs ungated.

[`.github/workflows/observability.yaml`](../../../../.github/workflows/observability.yaml) applies on push to `main` and on `workflow_dispatch` using environment `observability`. If that environment does not exist, the first push creates it with no rules and apply runs ungated.

## Comments
