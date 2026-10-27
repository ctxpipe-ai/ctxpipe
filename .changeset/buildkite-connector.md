---
"@ctxpipe/aws-cdk": minor
---

Add the Buildkite connector. An org admin connects Buildkite with an API access token that has only `read_pipelines` and `read_builds`. A Workspace source file selects pipelines. Each pipeline gets a `pipeline.md` file and one file for each of its latest 25 finished builds. The connector needs no new environment variable. Self-hosters get it with this release.
