---
"@ctxpipe/aws-cdk": patch
---

Ingestion v2 writes one knowledge file for each GitHub Actions workflow file of a source repository, in `knowledge/workflows/`. The file lists the triggers and the job IDs. It links to each service, app, or library whose folder a path filter or a working directory names. It does not copy commands, environment values, or secrets. A merged pull request that changes a workflow file links to its knowledge file. No new GitHub App permission is necessary. The skill bundle changes, so each Workspace at format 3 offers a re-ingestion.
