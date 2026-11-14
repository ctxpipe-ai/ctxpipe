---
---

The merge gate reads the changed paths of a pull request from git, not from the GitHub API. It waits for the reset of a GitHub API rate limit, and a rate limit does not fail the Terraform step or the PR comment step (CTX-1285).
