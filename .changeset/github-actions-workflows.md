---
"@ctxpipe/aws-cdk": patch
---

Ingestion v2 writes a knowledge file for a GitHub Actions workflow file of a source repository, in `knowledge/workflows/`. It reads at most 50 files that are directly in `.github/workflows/` and end in `.yml` or `.yaml`. It skips a file that has no jobs or that it cannot read. The knowledge file lists the triggers and the job ids. It links to each service, app, or library whose folder a path filter or a working directory names. It does not copy commands, environment values, or secrets. A merged pull request that changes a workflow file links to its knowledge file. No new GitHub App permission is necessary. The skill bundle changes, so each Workspace at format 3 offers a re-ingestion.
