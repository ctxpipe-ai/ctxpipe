---
"@ctxpipe/aws-cdk": patch
---

You can add a plain git repository to a Workspace by its https URL. In Workspace settings > Sources, open Add repositories and use the Paste URL tab. ctx| checks the URL with the plain git URL policy and opens a pull request that adds the source file under `sources/git/`. When the pull request merges, the first ingestion of the repository starts.
