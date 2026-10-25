---
"@ctxpipe/aws-cdk": minor
---

GitHub issues are mirrored into each Workspace that links the repository, the same as closed pull requests. Each issue is one file at `github/issues/<owner>/<repo>/<number>.md`, and the graph reads it as an `Issue`. Linking a repository backfills its 200 most recently updated issues.

Before you upgrade, give your GitHub App the repository permission **Issues: Read-only** and subscribe it to the **Issues** event. Then the owner of each installation must accept the new permission. Until the owner accepts, issues are not mirrored; pull requests and indexing continue to work.
