# ADR-057: Buildkite connector, Workspace sources only

**Status:** Proposed (the connectors area owner accepts or changes it in the pull request review) | **Date:** 2026-10-13 | **Tags:** connectors, buildkite, webhooks, git, workspace-sources

## Context

Agents need CI context: which builds failed, which jobs failed, and the commit and pull request of each build. Buildkite is the first connector that starts after [ADR-050](ADR-050-workspace-sources-config-file.md). It needs no per-connection sync repository, no `<slug>/config.yaml`, no legacy handover, and no source migration.

Buildkite has no OAuth application that other products can register. Third-party integrations use an API access token with REST scopes. A Buildkite webhook is a notification service that a Buildkite organization admin adds in Buildkite. Buildkite makes its token, and can sign each delivery with it (`X-Buildkite-Signature`: HMAC-SHA256 of `<timestamp>.<raw body>`).

Builds are high-churn. A busy pipeline finishes builds every few minutes.

## Decision

1. **Auth:** an organization owner or admin pastes the organization slug and an API access token with only `read_pipelines` and `read_builds`. The backend checks the scopes. It sends one GraphQL read query to make sure that the token has no GraphQL API access. That option is apart from the REST scopes and gives full access. Any answer other than a Buildkite refusal stops the save. A refusal is a 401 or 403 with a small JSON error body. The backend also lists one pipeline of the organization. All this happens before it saves the connection. The slug is the display name, so ctxpipe does not ask for `read_organizations`. The token and the webhook token are connection-specific secrets, encrypted on `connections.config`. There are no `BUILDKITE_*` environment variables, so hosted and self-host use the same flow, and traffic stays on the deployment.
2. **Scope:** a Workspace source file `sources/buildkite/<name>.md` selects pipelines by slug (`pipelines: [web-app, …]`). The slug is the API address and the path segment. A source holds at most 50 pipelines. The pipeline picker lists at most 1,000 pipelines of the organization and shows that the list is truncated.
3. **Egress:** only the backend and the worker call Buildkite. They call `https://api.buildkite.com`. The backend also calls `https://graphql.buildkite.com` for one read query when someone connects Buildkite. No sandbox gets the token or calls Buildkite.
4. **Content:** for each pipeline, `buildkite/pipelines/<slug>/pipeline.md` and one file for each of the latest 25 finished builds, `builds/<number>.md`. `pipeline.md` has the name, repository, default branch, and link. A build file has the state, branch, commit, pull request, creator, and the jobs that failed (not soft-failed), with links, plus timestamps in the front matter for provenance. The converter reads only the fields that it renders, so the build env, meta-data, message, job commands, and logs never reach a file. "Finished" is Buildkite's `state=finished`: passed, failed, canceled, and blocked. The pull request link uses the repository of the pipeline, because a fork's head repository gives a link that does not open. A GitHub repository gives `commit_url` and `pull_request_url` for graph joins.
5. **Reads:** one request for the pipeline and one for its latest finished builds with their jobs. The request count grows with the number of pipelines, not with jobs. A rate limit waits for `RateLimit-Reset` and sends the same request again.
6. **Live updates:** each connection has its own webhook URL, `/api/v1/webhook/buildkite/:connectionId`, as the GitHub App webhook does, because each webhook has its own token. The route looks up the connection through `connection_directory`, verifies the signature on the raw body (five-minute window), and refuses a plain-token delivery. The route reads the event name from the signed JSON body, because the signature does not cover the `X-Buildkite-Event` header. A `build.finished` event queues one full sync of the connection at the end of a 10-minute window. Later events in the window have the same idempotency key and queue nothing. A failed enqueue returns `503`; the next event in the window or the daily sync gets the build. The daily sync and "Sync now" also apply.
7. **Failures:** a 404 or 403 pipeline keeps its files and counts toward `out_of_access` after three cycles, as PagerDuty does. A 401 marks the connection revoked (compare-and-set on the token ciphertext) and keeps every file until a reconnect.
8. **Graph:** no connector extractor in this version. The mirror-unit kinds are `Pipeline` and `Build`, and the Markdown links join each build to its pipeline.

## Alternatives not taken

- **Buildkite OAuth token exchange:** in public preview, and it needs a signing key for each deployment.
- **One Event URL for each deployment:** Buildkite sends no subscription id. The route would decrypt and try the token of each Buildkite connection.
- **A patch for each finished build:** freshest, but one commit for each build in each Workspace.
- **Annotations:** the REST API needs one request for each build. The GraphQL API can return them in the same query; add them later if agents need them.

## Consequences

- No env, Terraform, Compose, or CDK change.
- A Workspace sees a finished build within about 10 minutes when the webhook is set, or within a day without it.
- A busy pipeline gives at most about six commits an hour in each Workspace that selects it.
- A renamed pipeline changes its slug. Its source goes `out_of_access` until someone selects it again.
- Removing the connection does not delete the webhook in Buildkite. The docs tell the admin to delete it.
