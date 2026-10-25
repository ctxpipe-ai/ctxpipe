---
"@ctxpipe/aws-cdk": minor
---

ctxpipe mirrors GitHub issues into each Workspace that links the repository, the same as closed pull requests. ctxpipe writes each issue to one file at `github/issues/<owner>/<repo>/<number>.md`, and the graph reads it as an `Issue`. When you link a repository, ctxpipe backfills its 200 most recently updated issues.

Before you upgrade, give your GitHub App the repository permission **Issues: Read-only** and subscribe it to the **Issues** event. Then the owner of each installation must accept the new permission. Until the owner accepts, ctxpipe does not mirror issues; pull requests and indexing continue to work. When the owner accepts, ctxpipe backfills the issues of each linked repository.
