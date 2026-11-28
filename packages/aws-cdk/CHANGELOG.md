# @ctxpipe/aws-cdk

## 3.4.0

### Minor Changes

- 9a7f2d7: `CtxPipe` deploys ClickHouse 26.10 for the new knowledge store. ClickHouse runs on one Graviton EC2 host in a private subnet. The data is on an encrypted EBS volume, and a stack delete keeps a snapshot of it. The old parts go to a private S3 bucket behind a cache on the volume. Only the backend, the worker and the migrate task reach it, on port 8123. The stack generates the admin, `ctxpipe_reader` and `ctxpipe_writer` passwords. Migrate gets the admin `CLICKHOUSE_URL` and makes the two users, the backend gets the reader URL, and the worker gets the writer URL. The size profiles set the instance and the volume (`small` t4g.large and 50 GiB, `medium` r7g.large and 100 GiB, `large` r7g.xlarge and 200 GiB). The VPC gets an S3 gateway endpoint, and `ctxPipe.knowledgeStoreAlarms` holds a status check alarm of the host (the host has detailed monitoring). The first deploy of this version adds these resources and replaces nothing that holds data. The new knowledge store stays off for every organization.
- b1c8f4d: Add the Buildkite connector. An organization owner or admin connects Buildkite with an API access token that has only `read_pipelines` and `read_builds`. A Workspace source file selects pipelines. Each pipeline gets a `pipeline.md` file and one file for each of its latest 25 finished builds. The connector needs no new environment variable. Self-hosters get it with this release.
- 3c09392: Chat: a new conversation starts from a base branch that you pick in the composer. Its session branch starts from that branch, each turn rebases on it, and its pull request targets it. The graph tools of the chat read the session branch when it has a knowledge projection. The API adds `GET /workspaces/{slug}/branches` and an optional `baseBranch` on the conversation; the migration adds the nullable column `conversations.base_branch` (ADR-071, CTX-1457).
- c0a4a61: Docker Compose self-host gets a ClickHouse service for the knowledge content, with its data on the `clickhouse_data` volume. The migrate service makes the ClickHouse tables. Set `CLICKHOUSE_PASSWORD` in `.env` before the first start. No feature uses ClickHouse yet.
- 7fd42d8: Add connection is now a catalog: views by group, a search, one state for each provider, and Fix for a connection that needs a reconnect or an unfinished setup.
- 0662b44: Knowledge plane: each result of `search_knowledge` and `get_related`, and the front matter of `read_file`, has the times of the unit: `createdAt` (when the item began in its source), `updatedAt` (when its content last changed in its source) and `expiresAt` (when the author sets it, a hint that the content can be stale). ctxpipe reads them from the properties of each file, with no case and no `_` in the compare, and never from the time of the projection run. `updatedAfter` filters on `updatedAt`. A mirrored item with no time of its last change uses its creation time, not a commit time. `validAt` and `validBetween` are removed: a document has no valid window, and each relation shows its own `validFrom` and `validTo`. ctxpipe no longer writes `valid_from` into the files of a Workspace. The upgrade rebuilds the knowledge plane of each Workspace.
- fd88f5c: The new knowledge store (ClickHouse) is on for each organization. You do not do a step to turn it on: the `knowledge_plane` organization setting is removed. After the deploy, the worker indexes each Workspace in ClickHouse. When the index of a Workspace is complete, chat and MCP read that Workspace from the new knowledge store. Until then, the old knowledge store answers. On our hosted service, the first index of a Workspace took about 3 minutes at the median, and up to about 30 minutes for a large Workspace. The chat composer of each organization now shows the base branch picker.
  
  The index runs and the searches send Workspace text, images and questions to three models on OpenRouter: the embedding model `openai/text-embedding-3-large`, the image model, and the decision model (Jev), each with zero data retention.
  
  The new knowledge store needs model settings that reach OpenRouter (`modelProvider.kind: "openai-like"` with the OpenRouter URL and key). Its decision model, embedding model and image model are only on OpenRouter. With `modelProvider.kind: "bedrock"`, the worker indexes no Workspace in the new knowledge store and logs `knowledge_plane.model_settings` at start, and the old knowledge store continues to answer.
  
  Docker Compose: the new one-shot service `clickhouse-secrets` generates the three ClickHouse passwords at the first deploy. You do not have to set them. A password that you set in `.env` replaces the generated one.
  
  Upgrade: there are no new required props. Run `pnpm update @ctxpipe/aws-cdk`, then `cdk deploy`. See "The switch to the new knowledge store" on the Upgrades page.
- 472dda4: ctxpipe mirrors GitHub issues into each Workspace that links the repository, the same as closed pull requests. ctxpipe writes each issue to one file at `github/issues/<owner>/<repo>/<number>.md`, and the graph reads it as an `Issue`. When you link a repository, ctxpipe backfills its 200 most recently updated issues.
  
  Before you upgrade, give your GitHub App the repository permission **Issues: Read-only** and subscribe it to the **Issues** event. Then the owner of each installation must accept the new permission. Until the owner accepts, ctxpipe does not mirror issues; pull requests and indexing continue to work. When the owner accepts, ctxpipe backfills the issues of each linked repository.
- bd33432: Add the Plain connector. An org admin connects Plain with a machine-user API key. A Workspace source file selects Help Centers, thread labels, or both. Thread text loses email addresses, phone numbers, and links that carry a credential. The connector needs no new environment variable. Self-hosters get it with this release.

### Patch Changes

- bbc3fa2: Each model call to OpenRouter now allows only zero data retention (ZDR) endpoints with no data collection: the model tiers, the embeddings and the OpenAI-compatible proxy routes too, not only the knowledge plane. A model with no ZDR endpoint fails. The new optional setting `MODEL_PROVIDER_ALLOWLIST` (OpenRouter provider slugs, separated by commas) limits each OpenRouter call to these providers.
- 6d1092d: When Agent Vault restarts, it keeps no data, and a running ingest shard loses its vault. The shard step now destroys the sandbox of the shard. The next attempt of the step makes a new sandbox with a new vault, proxy session and CA. Before this change, each later step of the shard failed until the run ended.
- c77074f: The backend registers the Agent Vault owner again when a replaced Agent Vault task answers its cached login with 503 `not_initialized`, so a new Agent Vault task no longer fails each vault call until the backend restarts.
- 621714f: A new AgentCore chat sandbox runs its setup steps as one command and probes no lock files. A busy conversation's Files and turn reads poll with backoff.
- 82bc527: A new AgentCore chat conversation claims a warm session of its Workspace that already holds the repository clone, so it skips the session create and the clone. Each Workspace keeps at most one warm session, and each organization at most three, for 12 minutes after chat use.
- 841d0aa: Chat: a turn no longer repeats the AgentCore session check of its prepare. It stops an earlier OpenCode server in the same command that stops the other processes of an earlier turn (AgentCore and Docker). Thus the first answer comes sooner.
- 026cf0a: Chat on AgentCore: each new sandbox session runs OpenCode once before the first turn starts it, so the first answer comes sooner.
- 8c8c15b: The AgentCore sandbox reads each shim answer to its end, so a staged command or a port request no longer shows as an aborted HTTP call.
- 38c3fe9: Fresh installs failed because AWS retired Aurora PostgreSQL 16.4 (`Cannot find version 16.4 for aurora-postgresql`). The construct now pins 16.13, the AWS default 16.x minor. The major version stays 16.
  
  Upgrade: there are no new props. Before the first deploy, read the cluster version with `aws rds describe-db-clusters`. If `EngineVersion` is higher than 16.13, set that version on the cluster before you deploy (see "Aurora PostgreSQL minor version" in the README). CloudFormation cannot move a cluster to a lower minor. This can happen after an automatic minor upgrade. Then run `pnpm update @ctxpipe/aws-cdk`, then `cdk deploy`. An existing cluster on 16.4 to 16.11 is upgraded in place to 16.13 (a short database restart). A cluster that is already on 16.13 does not change. CloudFormation does not replace the cluster.
- ff67b26: The auth rate limit and the session use the client address that the nearest proxy appended to X-Forwarded-For. Behind Cloudflare and behind the preview router, a client can no longer choose its address with its own X-Forwarded-For or X-Real-IP header. The server render of the UI forwards the client address headers. When the UI calls the backend on its private address, as on the hosted stack, the backend rate limits each browser and not the UI server. A job that a request queues and that fails after the response writes its error as an event of its own, with the request id. evlog writes no "log.error() called after the wide event" warning.
- 5babf41: Update Better Auth from 1.6.23 to 1.7.25, which includes the fix for advisory GHSA-965c-763c-88jm (CVE-2026-114607). ctxpipe does not enable the Magic Link plugin, so the attack in that advisory did not apply. A new migration adds the tables and nullable columns that the Better Auth 1.7 OAuth provider needs. Better Auth 1.7 does not start before this migration runs. MCP OAuth keeps the same behavior: an MCP host that registers an `http` loopback callback without an `application_type` can still register, and every client can still ask for a token for `{AUTH_BASE_URL}` and `{AUTH_BASE_URL}/mcp`. Linking an Atlassian account that another user already linked still offers the claim of that account, and "Unlink" and the email of a linked account in the account settings still work. The Atlassian link callback now finishes a link only in the browser session of the user who started it. The API and MCP refuse a key-bound (DPoP) access token, because they check no DPoP proof. After the update, a sign-in or an MCP OAuth authorization that started before the update cannot complete. Start it again.
- a4f805e: Workspace chat on hosted sandboxes: when a sandbox start passes its deadline, the backend deletes that sandbox a second time 90 seconds later. Thus a sandbox that the provider makes after the first delete does not stay with no owner.
- afddc49: Chat: when the org's `knowledge_plane` flag is not `off`, the base branch of a new conversation is a quiet branch control in the composer footer, with a menu that has a search field. The control shows the default branch at once; only the menu waits for the branch list. After the first message, the conversation header names the base branch and the session branch as plain text. The suggested prompts are a centered row of short pills under the composer; a pill puts its full prompt in the composer. The Workspace API adds `defaultBranch`, and the Workspace list adds the org's `knowledgePlane` flag (CTX-1468).
- c5f33aa: Chat: the GitHub read token of a prepare or a turn is minted only before the first Git command that reaches GitHub. A turn mints it at once in parallel with its sandbox setup, and a prepare that runs no such command mints and revokes nothing.
- 647f14c: Workspace chat list: each chat has a "more" menu with Rename and Delete. Delete asks for confirmation. The backend now refuses to delete a chat while a turn runs in it (409 `turn_running`), so the user stops the turn first.
- d26de7e: Each chat in the Workspace chat list now shows a status dot: gray (idle), a blue spinner (working), green (finished, not opened yet), and orange (failed, stopped before it answered, or waiting for you). The chat list API adds a `lastTurn` field to each chat. There is nothing to configure and no migration.
- 9207700: Chat: a NUL character in a tool result no longer fails the save of a chat thread.
- 727dc5c: Chat: OpenCode starts while the turn moves the sandbox to the Workspace commit and takes its start snapshot. The prompt waits for both, so the first answer comes sooner.
- 9909a29: Chat: a turn does not write the proxy CA again into a sandbox that its prepare gave the same CA less than 60 s ago. Thus the first answer of a new conversation comes sooner.
- c9e3ced: Workspace chat: a turn saves the question and its running state first, before the sandbox setup. When the user leaves a chat while its sandbox starts and then opens the chat again, the chat shows the question and the live progress, and then the answer. A turn that stops during the setup keeps the question and shows as stopped or failed.
- 951221a: Workspace chat: the reply text is no longer lost when the event stream from the chat sandbox is slow. Before this fix, a turn could end with only its tool calls, and the stored conversation had no answer text.
- 85d0069: A chat sandbox start holds the Workspace lock only until its sandbox is created, so the clone and the setup of one conversation no longer make the next conversation of the Workspace wait.
- b85d096: While a chat sandbox starts (a prepare or a sandbox resume), file reads and Delete answer `chat_starting`, not `turn_running`. The file pane shows "The chat is starting…" and asks again by itself. Delete waits up to five seconds for the start to end, and then deletes the chat. If the chat still starts, Delete tells the user to try again in a few seconds. Pane errors show text with a next step, not a raw error code.
- b34964c: Workspace chat: a turn continues on the server when the user leaves the conversation, and the answer is saved. When the user comes back, the conversation attaches to the running turn or shows the answer. Only the Stop control stops a turn. A turn that stops before its first answer keeps the question and shows a Retry action.
  A turn stops after two hours. When a deploy or a crash stops the backend during a turn, the turn shows as stopped when the user opens the conversation again, and push and pull request are no longer blocked.
- d84e8e2: Chat: a cold turn on AgentCore no longer waits for the OpenCode warm-up, which now runs at the lowest CPU priority beside the clone.
- 4d7e065: Docker Compose self-host gives each service its own ClickHouse user. The migrate service keeps the admin user and makes `ctxpipe_reader` for the backend (read only) and `ctxpipe_writer` for the worker. Set `CLICKHOUSE_READER_PASSWORD` and `CLICKHOUSE_WRITER_PASSWORD` in `.env`, with values different from `CLICKHOUSE_PASSWORD`. They have no default: without them, the backend and the worker cannot connect to ClickHouse.
- aebd0e8: Codesearch deletes old checkouts. Each ingested commit and each Workspace revision kept a full clone, Zoekt shards, and SCIP files on the codesearch volume, and the volume grew without a limit. The worker now deletes the checkouts that no reader needs, after each repository publish and every hour. The first run after the upgrade cleans every repository.
- b6c90c1: Codesearch keeps the caches of the SCIP indexers in `indexer-cache` on the data volume, beside the repository cache, and empties them above 20 GB. Each indexer run gets its own temp directory there, which codesearch removes when the run ends.
- 69aebc0: The codesearch image now has scip-clang and scip-ruby on linux/arm64 too. Both indexers are built on Debian Bookworm, so scip-clang also starts on linux/amd64 again: the upstream binary needed a newer GLIBC than the image has.
- 324bf04: Codesearch keeps one copy of each repository: one shared git clone with a worktree for each checkout. Workspace code reads use the published checkout. The hourly cleanup also deletes files that no checkout row names. The codesearch volume needs less disk, and a clone stops with a clear error when the free disk space is too low. On the first start after the upgrade, codesearch empties its repository cache and its Zoekt index one time. Code search and code reads are empty for a short time (up to about one hour, plus the index time) while codesearch indexes each published repository again. This index uses only codesearch: no re-ingestion starts, and no model cost occurs. During an update with the CDK, Workspace code reads can fail for a few minutes, until all services run the new version.
- 98fcbd0: Codesearch runs one SCIP indexer process at a time. A Zoekt index can still run beside it. `scip-python` now gets the same capped Node heap as `scip-typescript`. Before, two large SCIP indexers could run together and take more than 90% of the codesearch memory.
- b4155ad: The codesearch image trusts the Amazon RDS CA bundle (`NODE_EXTRA_CA_CERTS`), as the backend and worker images do. A database URL that asks for a verified TLS connection (`sslmode=verify-full`) to Aurora now passes the certificate check. The database URLs of the construct do not change.
- 896b258: The commit-subject model call now waits up to 15 seconds, not 5 seconds. A slow but normal answer no longer falls back to the fixed subject (part of CTX-1303).
- 46f5c4e: UI fixes in the service images. The PagerDuty service picker shows the name of a selected service after a new search, not its id. Onboarding no longer shows a second "Could not finish onboarding" error when the session refresh is slow. The tools pane header shows the conversation title when the conversation list loads, not "New conversation". With reduced motion, the knowledge graph calculates its layout before it shows, and shows when the layout stops. No construct change.
- 17469c8: UI fixes from the review of a sample of the stories:
  
  - Quiet buttons, and the email and organization under the names in the side nav, are easier to read.
  - A toast that confirms an action or reports an error has a dark surface, with the color only on its icon.
  - On a phone, the page content uses the full width under the menu button.
  - The page loading skeleton shows its lines one under the other, and its rows fade. The weekday letters of the date range calendar use the regular weight.
  - Workspaces: a destination row has a chevron; a push entry says when GitHub did not open the pull request; the submit button of the repository picker always shows; the graph card has Try again.
  - Connectors: a connection whose status check failed says so and offers Retry; an OAuth error shows as an error alert with a title.
  - Sources and upgrades: the Linear and Slack scope editors show a load error with Retry; the Add to Workspaces step shows each upgrade link one time; an upgrade item does not repeat its status, and a re-ingestion does not ask for a format upgrade that the Workspace already has.
  - Home, chat, account and onboarding: a closed activity row in the chat has a chevron; the revoke and onboarding errors give the next step.
- bf4d118: The "Connect GitHub" button stays in progress while the page goes to GitHub or to the next setup step (CTX-1436).
- efa8dfd: Optional `GITHUB_WEB_URL` and `GITHUB_REDIRECT_URI` let a forwarder serve the GitHub pages of the deployment's App and its callback: the authorize page of GitHub sign-in and of the installation proof, the App's install page, and the OAuth callback. Set both or neither. Unset, ctxpipe uses `https://github.com` and `{AUTH_BASE_URL}/.auth/api/v1/auth/callback/github`, as before. `GITHUB_WEB_URL` replaces `GITHUB_AUTHORIZE_URL`, which no release had.
- 0ca8663: The knowledge units and chunks of the Postgres pipeline hold scrubbed text: each secret becomes `[REDACTED:<rule id>]` before the units are cut into chunks. A stored unit with a secret gets its scrubbed text at the next hydrate of its Workspace.
- 7954ac7: Before each model call, the backend removes the secrets from the text with Kingfisher. Each found secret becomes `[REDACTED:<rule id>]`. This applies to the embeddings, the LLM tiers, the OpenAI-compatible routes, Jev and the vision prompt. Images are not changed. The scrubber needs no setting. If it cannot start, the server does not start.
- 5efa184: The secret scrubber also removes the credentials of a URL of any scheme before a model call: the user and password part of `scheme://user:password@host` becomes `[REDACTED:url-credentials]`.
- 60006ae: The two OpenAI-compatible model proxies of the backend convert each PDF file part to text with the backend's own converter before the model call. No file part goes to the model provider. A file part that is not a PDF, or a PDF that the converter cannot read, makes the request fail with a clear error. Image parts are not changed.
- 4a8ed2d: Knowledge plane: `search_knowledge` gives the top 50 documents, not the documents of the top 50 chunks. Before this change, a long document with many matching chunks took many of the 50 places. The full-text part of the search now weighs each query term by how rare it is, so a common word such as "a" or "is" adds almost nothing to the score (CTX-1455).
- 2159480: Knowledge plane: `get_related` always reads the relations of its seeds. Before this change, the relevance judge could stop the traversal at the seeds, so `get_related` returned only the seeds. The judge now decides only from which found documents the traversal continues (CTX-1455).
- 5a610c1: Sandbox Git sends the proxy session in its first CONNECT, so parallel ingest fetches do not get a proxy 429. A prepare clone runs again after a short 429 burst, and it waits for the Retry-After of the proxy (CTX-1470).
- 2e749c7: An ingestion publish no longer fails when another source of the same Workspace created the same shared instruction file after the pin. The semantic merge now keeps the sources of both versions (CTX-1471).
- 0cf8c61: The sandbox host runs Agent Vault with its pre-auth gate off (`AGENT_VAULT_RATELIMIT_AUTH_MAX` at its largest value, a 1-second window) and its rate limits locked. One sandbox that fails proxy auth no longer locks out the other sandboxes.
- 52c97cf: The workflow worker claims runs in the order they became available. Before, it claimed each new run first. Thus a parent run that its child had woken waited for a free worker slot while newer runs took each slot, for up to 32 minutes during an ingest (CTX-1478).
- 1afe87c: Ingestion has no op cap any more: a run of a large monorepo publishes all of its files. Before, a step took at most 30 ops and a Workspace at most 300 in a run. The skill scripts no longer page at 30 files: a page ends only at the size limits of a step, and the `dependencies` skill no longer skips each stream file after 28. A Workspace whose assemble is refused now publishes nothing, and the run span shows the refusal with the error status and the fixed codes of the cause (CTX-1482).
- 9c8a748: The `datasources-infra` skill of ingestion writes its store and infrastructure files with a script from a plan of the model, and it refuses a store that its finder did not list. It pages by a cursor over the stores of its finder, and no skill has a limit of 20 pages. The finder also finds Valkey, Infinispan, FalkorDB, the Keyv stores of Redis and Memcached, and the `pgvector` image of PostgreSQL (CTX-1487).
- 94e13c7: The `decisions`, `apis`, and `dependencies` skills of ingestion have no page count: each page moves a cursor over the candidates of the skill's own finder. They also have no count caps that drop input. The scripts read each decision file, specification operation, route, and dependency candidate. A list for the model ends at a size limit, and the next run gives the rest. `classify-kind` and `instruction-areas` have one page; when that page says that files wait, the skill stops as partial and keeps its files. The new skill bundle version offers a re-ingestion (CTX-1487).
- 1167791: The `repository`, `libraries`, and `ownership` skills of ingestion have no page count: each page moves a cursor over the finite input that the skill's own finder gives before the page, and the skill stops when the cursor reaches the end. A page whose cursor does not move forward stops the skill as partial (CTX-1487).
- 9174bb2: While the role of the user loads, the automatic upgrades switch of the Upgrades card shows no help line. Before, it showed the member line ("An owner or admin starts each upgrade…") to each user, owners and admins too (CTX-1492).
- ba58b4f: Ingestion now writes a decision file for each design record that is not an ADR: a KEP (`README.md` with `kep.yaml`), an RFC (a numbered file in `rfcs/`, `proposals/`, or the `text/` folder of an RFC process), a PEP, and a file in a design folder such as `docs/design/`. Each decision file has the status of its process (for example provisional, implementable, implemented, postponed, or withdrawn) and its declared supersede links (CTX-1501).
- f4f09b2: Knowledge plane: a mirrored issue mentions the code knowledge that it names (APIs, operations, services, libraries, package roots), and `get_related` weighs each mention by the specificity of its key (CTX-1502).
- 8af2f07: The secret scrubber no longer stops on a text with the line separator (U+2028) or the paragraph separator (U+2029). Before, such a text stopped the scrubber, so each model call in flight failed, and the hydrate of a Workspace with such a file failed on each retry.
- 7d2e6ba: An org owner or admin can cancel a queued or running re-ingestion. The cancel stops the upgrade run, its repository runs and their ingestion runs, so they make no more model calls and publish nothing. The re-ingestion shows "Canceled" and can start again.
- b118751: Ingest finds more code roots. A Cargo path dependency of a workspace member is a root, and so is each member of a nested Cargo workspace. A Go `main` package in a folder of a module (for example `cmd/<binary>`) is a root, and classify-kind makes it a Service. Folders for tests, examples, and generated code do not give these roots.
  
  No count limits the roots of a run. Before, discover-roots gave at most 2,000 roots, and a run with more than 400 roots planned no root. Now the size of the discover-roots result is the only limit (1 MiB). Above it, the script gives the first roots and records what it did not give.
- fb2c7c3: Ingest: the apis skill reads each specification file up to 32 MiB, and keeps the operations of the first 32 MiB of a larger file (CTX-1511).
- fdbbdb3: Ingestion writes more knowledge. The `ownership` skill reads `OWNERS` and `OWNERS_ALIASES` files: each alias becomes a Team file. A new `feature-gates` skill writes one FeatureGate file for each Kubernetes feature gate and each Rust compiler feature. A fast-tier model step chooses the ambiguous roots of `discover-roots`, so they are not dropped. Package and repository files get the purpose of the package as their summary, not a placeholder (CTX-1513, CTX-1514). A purpose that looks like an instruction to an agent is not used, so the file is still written (CTX-1536).
- 0b1c898: An ingest step does not start on a shard sandbox at the shard limit. It deletes that sandbox, and the step makes a new one with a new proxy session. Before, a shard that ran for more than 75 minutes kept its sandbox after its proxy session ended, and each Git fetch of a root step failed with exit code 128 (CTX-1515).
- dc5dcac: Knowledge: a document is valid from the time of its source (the creation time of a mirrored issue, pull request or Slack thread, or the date of a design record), not from the ingest date. Thus a time question with `validAt` finds the knowledge of that time. A file with no time of its own keeps the time of the commit that introduced it (CTX-1516).
- 17ca4c0: The knowledge plane repairs a Workspace whose ClickHouse rows are lost. When the head of the default branch shows no tree row, the next projection run rebuilds the Workspace in full from Git. Before this change, the run answered `current` or applied only a delta, and the Workspace stayed empty. For a partial loss, an operator can start a full rebuild with `src/scripts/rebuildKnowledgePlane.ts`. With the `knowledge_plane` flag `on`, the graph pane now shows the graph when the plane is ready, also when the FalkorDB graph is still pending.
- e4e0ed0: A mirrored file that holds a NUL character (for example a GitHub issue body that quotes a Git protocol error) no longer fails the hydrate of its Workspace. The hydrate removes each NUL character before it writes Postgres and the graph.
- 5236d18: The spend of an ingest run uses the gateway cost that the model proxy records for each step, not the OpenCode estimate (CTX-1522).
- 627d928: Linear: the issue mirror writes `completedAt` and `canceledAt` in the front matter. The knowledge plane links a done or canceled Linear issue to each merged GitHub pull request of its attachments from that time, as it links a closed GitHub issue from `closedAt`. Thus a time question with `validAt` finds when a Linear issue was done (CTX-1526).
- 2fef099: Ingestion keeps each Related line of a shared file. When a Stream file or a store file passes the 64 KiB file limit, the next lines go to the parts of its list, and the skill does not stop as partial. A part of a file with a long name gets a short, fixed name. Each run of a skill page adds to the files that an earlier run of the page wrote. The new skill bundle version offers a re-ingestion (CTX-1528).
- 45108ee: Ingest: each skill uses one rule for test fixture folders (for example `artifacts`, `testdata`, and `fixtures`), so the apis skill no longer reads a test copy of an API specification as an API (CTX-1531).
- 303353d: Knowledge plane: `get_related` keeps each document that Jev marks to explore as a step, also when no answer comes after it (CTX-1534).
- fe580cb: Security fixes from the npm advisories that reach the backend:
  
  - `/mcp` refuses a request body over 4 MiB and a tool call with more than 10,000 input elements (GHSA-f897-62hf-6gxq, GHSA-46jr-4wx8-v453). The MCP SDK is now 1.32.
  - zod 4.6.7 stops a validation of an oversized array from exhausting memory (GHSA-mrhx-c7xc-m3w5).
  - Device login (`ctxpipe auth login`): only the ctxpipe CLI can start one, and the approval page no longer approves a code from a link by itself. The CLI now always prints the code, and the person compares it with the page and presses Approve (GHSA-q84f-53jg-9ppm).
- cb26578: Knowledge plane: the search gives the same hits for the same query (CTX-1547).
- df0db95: Knowledge plane: get_related waits for less, with the same results (CTX-1548).
- 12ac74f: The backend image runs on @linear/sdk 102, octokit 5, dockerode 5, nodemailer 10, graphql 17 and @react-email/components 1 with @react-email/render 2; its emails show the same text, and their plain-text parts no longer start with the hidden preview line (CTX-1563).
- f2d36de: The backend, codesearch and UI images run on Hono 4.13, @hono/zod-openapi 1.6 and @hono/mcp 0.3, and the Files pane editor on Pierre diffs 1.6 (CTX-1563).
- f7fbb4d: The codesearch image builds its tools with Go 1.27.4, .NET SDK 8.0.428, and newer Rust and Dart base images (CTX-1563).
- 7627e81: The service images take the newest OpenTelemetry JS SDK 2 releases (stable 2.12.1, experimental 0.223.2). Outgoing HTTP client spans of the backend now carry only the stable HTTP semantic-convention attributes, for example `http.request.method`, `url.full` and `http.response.status_code` (CTX-1563).
- a4b61c6: The service images and the CLI take the newest patch and minor versions of their npm dependencies (CTX-1563).
- 1c3aadf: The UI image takes the newest TanStack Query, Virtual, Charts 1.x and Devtools releases (CTX-1563).
- 0918a2a: The UI image builds with Vite 8 and TanStack Start 1.169, and the tests run on Vitest 5 (CTX-1563).
- f4fb38b: The `ctxpipe` CLI now needs Node.js 22.12 or newer (`engines`), because chalk 6 and commander 15 dropped older versions. The backend takes uuid 14, which changes no behavior that operators see.
- ed306e3: The UI image builds with lucide-react 1 and tailwind-variants 4 (CTX-1563).
- bff30f2: The UI image builds with React 19.3, Base UI 1.9, React Aria 1.22, Tailwind CSS 4.3 and streamdown 2.7 (CTX-1563).
- 474a31f: Knowledge plane: a lexical chunk with a small share of the query terms has less weight in the fusion of the search (CTX-1564).
- 474a31f: Knowledge plane: the title boost of the search weighs 4 times the term weight (CTX-1564).
- 93e7c34: Knowledge plane: get_related asks the disagreement facts with the judge of the last layer, so a full walk waits for one Jev round less (CTX-1566).
- 3afd9a6: Ingest: the `instruction-areas` skill reads all practice documents in pages that fit a read budget, with no limit of 150 documents and no count limits for areas, rules, or notes. An area file keeps the rules and notes that fit, and `skipped` lists the others. A page that reaches the end of its input ends the skill as done, so a step checkpoint on the last page and an `apis` root with no found operation no longer end the step `partial`. `discover-roots` records each Go `main` package in a test fixture folder in `skipped` (CTX-1570).
- aecfc80: Knowledge plane: the search waits for less, with the same answers (CTX-1576).
- 700cd9a: Knowledge plane: the Jev layer judge cuts its batches in the order of the document keys, not in the search rank, so that the order of the hits does not change a judgment (CTX-1577).
- 39156af: Knowledge plane: get_related bridges to the documents of other sources, and Jev reads the relation that reached a candidate (CTX-1578).
- a903594: Knowledge plane: an issue also mentions names in code (`build_helper::git::…`), an operation with a lowercase method in a code span (`get /entities`), and product names (`Amazon S3`, `Catalog API`). The projection version changes, so each Workspace projects its knowledge plane again, with no model call.
- 6787960: Chat runs on TanStack AI 1.x (CTX-1580). Stored chats load and resume as before. A migration cancels pending chat interrupts that 1.x cannot resume; none are expected.
- 19aaacc: Knowledge plane: two items whose pair updates or contradicts never share a position of get_related, whatever a third item agrees with (CTX-1588).
- 19aaacc: Knowledge plane: the disagreement step reads the scoped fact as "yes" from p(yes) 0.6, not 0.5, so that fewer current positions of get_related are "scoped" (CTX-1588).
- 31bd92a: Knowledge plane: a slow Jev call sends a second copy of its request after 700 ms, and the first copy that ends gives the result. This cuts the get_related tail latency and adds about 2% more Jev calls (CTX-1590).
- 21f43ba: Linear webhooks of one connection now coalesce. A burst of Linear events gives one sources sync in each 10-minute window, not one sync for each event. Thus a burst also gives one connector mirror write and one merge for each Workspace. No event is lost: an event that comes while a sync runs goes into the next sync.
- d90dd8e: One semantic merge of a Workspace runs at a time. Before, the queued merges of one Workspace raced on its default branch: each push made the other merges discard their merge commits and merge again. Now a merge waits for the lease of its Workspace without a worker slot, then merges once onto the newest tip. No change is lost.
- 3e87780: A Workspace step that reads commits from the Git host now downloads only the objects that changed since an earlier read of the same repository. Before, each step downloaded the full tree of the commit again. A large repository on a slow Git host then stopped at the 60 s limit 3 times in each step, and the PR mirror and the sources sync of that repository failed. Now a fetch stops only when the Git host sends no data for 60 s, or after 10 min. After such a stop, the steps of that repository fail at once for 5 min with a clear error, and do not hold a worker slot.
- 8966f5f: A Git fetch, clone or `ls-remote` that stalls on Linux now stops at its time limit: Git runs in its own process group, and a stop ends its helper processes too (CTX-1601).
- 2b4d74a: Knowledge plane: search_knowledge adds the documents that its best hits name, in the last places of the hits (CTX-1605).
- 1209b08: Ingestion has no throttle of its own. More than one re-ingestion of an organization runs at the same time, and the source repositories of one re-ingestion run at the same time. Shards have at most 5 roots and start in a sliding window. Ingestion shards use at most half of the OpenWorkflow worker slots, so the other jobs keep the other half. The publishes to one Workspace run one at a time, so each publish lands.
- 26b4cb0: The weekly dependency batch of 2026-11-25: dependency updates within the 7-day wait, in the app images and the CLI's runtime dependencies.
- edd2ef5: The backend adds the table `crm_intake_outbox`. Hosted ctxpipe records each new sign-up there, and its worker sends the sign-up to the CRM of the ctxpipe team. A self-hosted deployment does not record or send anything: only a deployment with `DEPLOYMENT_ENVIRONMENT=production` and `CRM_INTAKE_URL` records, and a self-hosted deployment does not set them. The table stays empty.
- 6f86ae7: An ingestion shard that has no place in the worker share now waits in the OpenWorkflow queue: a worker process does not claim a shard while it runs its share of shards. The worker queue depth counts these shards, so the worker scales out, and a free place goes to the shard that waits longest.
- e8f61e0: Knowledge plane: the deletion of an org or a Workspace deletes its rows in ClickHouse. The delete queues the `knowledge-purge` workflow. The worker waits until the delete is done and no knowledge projection run of the org or the Workspace is running. Then it deletes the rows of each knowledge table with the writer user. An org delete turns the knowledge flag of the org off at once, and the purge also deletes the knowledge state of the org in Postgres.
- 24d8fba: Knowledge plane: when an org leaves `off`, the operator path and each deploy queue the first projection of each Workspace that is not ready (CTX-1643).
- 561f531: The operator job `admin.set-org-feature` sets an org feature to `off`, and the hosted config does not undo it.
- 87f1c21: Workspace sources: a plain git source file can pin a full commit SHA with the key `commit`. Each ingestion of a pinned repository reads that commit, not the tip of a branch, when each plain git source of the org that names the repository pins the same commit. The OrgBench corpus steps write such source files for the public repositories of a twin, in place of private snapshot copies.
- e21e1e9: Knowledge plane: after a purge deletes the rows of an org or a Workspace, ClickHouse also removes the bytes of those rows from the parts, on the hot volume and on the cold volume. The purge run waits until the parts that held the rows are gone from the disk, and logs when this is done. A purge run that fails starts again the next day. The migrations give the writer user read access to the part names in `system.parts`.
- 45b4488: Knowledge plane: the store search reads the neighbors of its best hits in one query, at the same time as the documents of the hits. The search gives the same hits, and the neighbor step adds about 22 ms (p50) in place of about 165 ms (CTX-1683).
- 4c9cbdc: Knowledge plane: the disagreement step reads the "changes or replaces" fact as "yes" from p(yes) 0.35, not 0.5 (CTX-1684).
- 4c9cbdc: Knowledge plane: the disagreement step reads the `scoped` fact as "yes" only from p(yes) 0.8, not 0.6 (CTX-1684).
- 4c9cbdc: Knowledge plane: a stored SUPERSEDES between two evidence items gives their pair the label `updates`, so the two items never share a position (CTX-1684).
- 288e6be: Knowledge plane: the search reads only the out-relations of its hits, a read of many documents no longer fails on the ClickHouse limit of one query parameter, and each ClickHouse read has a span.
- 0dabf04: Knowledge search: the `updatedAt` of a connector mirror file (Linear, GitHub, Notion, Slack, Plain, PagerDuty) is the time of the last change in the source, not the time of the last commit. The `updatedAfter` filter uses this time. A mirror format change that rewrites each file no longer makes each file look new.
- 496897a: GitHub mirrors: an operator script cleans up the pull request and issue mirrors of one Workspace one time. It deletes the mixed-case copies of a path, moves a mixed-case file to its lowercase path, and deletes the mirrors of repositories that no source holds. The script is a dry run with counts only. With `--apply`, it queues one host commit through the write broker.
- e15d64f: The `get_related` tool description says when statuses and recency apply.
- ecb3eb1: Knowledge search and `get_related`: two paths of a Workspace that differ only in case (for example `Billing.md` and `billing.md`) are one document. A read shows the copy that Git changed last, and a link to the other copy goes to it. Before, an agent got two answers for one file, and one of them was usually old. `read_file` and `list_files` give one answer too. On an org that uses the knowledge plane, the hourly tip check finds such paths, and ctxpipe repairs them: a direct commit keeps the lowercase path when the copies have the same content or ctxpipe owns the file, and a pull request merges two edited copies for a person to review.
- 4f21f71: The unlink retraction also deletes the GitHub pull request and issue mirrors of the unlinked repository, in the same commit (CTX-1698).
- efd394a: The backend no longer stops when its OTLP collector is down during shutdown. A failed telemetry export now writes one `otlp.export-failed` log line per minute, not one line with a stack for each batch. On ECS, backend and worker telemetry carry the task id as `service.instance.id`, and both report the gauge `process.memory.usage` (resident memory in bytes). When the worker process exits, the `openworkflow.worker-exited` line names the workflow runs that it held.
- 45ed67a: Worker: the claim takes the next workflow run from the org that runs the fewest runs now. A large backlog of one org no longer holds back the runs of the other orgs. One org alone still uses each free slot.
- 30100f6: Two frequent worker reads use an index: the owner run of a write job (by its id or its idempotency key), and the test that each knowledge unit has chunks (a new index of the chunks by org, Workspace and unit, which replaces the index by org). Before, each read went through all of its table (CTX-1708).
- d090c79: Knowledge plane: each Linear issue is `PART_OF` its parent issue, its project and its team, and `HAS_LABEL` each of its labels (all labels). Now `get_related` from a label returns the issues that have the label, and an agent can tell each relation apart. An id with no mirrored file makes no relation. The next projection run of each Workspace rebuilds it and adds the relations.
- a1ab743: `get_related` on the knowledge plane gives no position and no status. It shows the claims between the top results: each stored relation with its predicate, source, `validFrom`, `validTo` and confidence, and each reading of the model with its confidence. Each result shows its source type (CTX-1720).
- 7fa7262: Migrate no longer leaves the migrate role a member of `ctxpipe_console`. On RDS, `ctxpipe_console` is a member of `rds_iam`, and with IAM database authentication on, RDS then refused the password of the migrate role ("PAM authentication failed"). The next migrate removes the membership that an earlier migrate left.
- 3232736: Connector mirror writes and other Workspace writes no longer fail at `acquire-revision` with `index-pack --stdin` "Command failed" when the Workspace repository is large. The worker now decodes the Git pack to a file in chunks, and Git reads that file itself. A failed Git command now shows its exit code or signal and its error output.
- 39fc2d1: A Workspace write no longer keeps the Git pack of the Workspace in its workflow step outputs. Each write step gets the commit from the Git host. This decreases worker memory and Postgres traffic for large Workspaces. The worker logs a warning when a workflow step output is larger than 1 MiB.
- 5dc5385: A conversation with no changes of its own no longer shows "Branch needs a rebase" when the Workspace gets new commits. Its next turn moves it to the new commit. A conversation with its own changes shows "The Workspace has new commits" and does not name a conflict.
- 8e6ff99: An ingestion run that waits for an earlier run of the same repository now goes on after 60 minutes of wall time. Before, it counted 60 checks, and a busy worker made that wait almost 3 hours.
- 353886a: The codesearch runtime and the chat sandbox image now use Debian 13 (Trixie). Debian 12 has critical CVEs that it does not fix. The chat sandbox uses the slim Node image, which is about half the size. Codesearch keeps JDK 17, now from the Temurin image, and Maven 3.9.
  
  The AWS sandbox host now runs Agent Vault 0.40.2 at a fixed digest, not `latest`. A new pin replaces the sandbox host on the next deploy, and the new host starts an empty Agent Vault.
- 4f58977: The backend, codesearch and the UI read one platform-neutral deployment name, `DEPLOYMENT_ENVIRONMENT`. `RAILWAY_ENVIRONMENT_NAME` stays a fallback while Railway previews exist.
- 151c14e: ctxpipe now sends users and agents to the product docs. For a question about ctxpipe itself, the Workspace chat reads `https://docs.ctxpipe.ai/llms.txt` and gives the link of the matching page. The MCP server instructions, the Slack bot reply, and the Claude plugin skill give the docs too. The sidebar has a **Docs** link.
- e851c5f: The worker keeps the knowledge plane off, and logs an error at start, when `MODEL_PROVIDER_ALLOWLIST` does not include `typesafe`, the only provider of the decision model (Jev). Before this change, such a list let each Workspace become ready, and then each plane read that needs Jev failed. A new env contract test checks that each ECS task of the construct and each service of the Compose `deploy` profile pass the start check of the backend and the plane rule, and get the settings that they need.
- 75445d6: The worker now runs the tip check of each org with a Workspace once each hour, at a time in the hour that comes from the org id. A Workspace graph or index that failed to build (for example while the graph store was down) now builds again with no new commit: 1, 2, 4, 8 and 16 hours after it first failed, then once each 24 hours. While that retry builds the graph, the Workspace pane shows "Building graph".
- 7aafa95: The Files pane shows a preview of PNG, JPEG, GIF, WebP, and SVG images, and lets users download other binary files. New raw file endpoints for a Workspace and a conversation send the file bytes, with a 10 MB limit. Codesearch does not read a file that is larger than this limit for these endpoints. Update the backend and codesearch images together.
- cb01bc8: The Confluence Forge webhook accepts a call only from the Forge app of the connection, with the Forge issuer. Forge provisioning saves the app ID before it installs the app. The installation and the site come from the signed Forge claims.
- f64e430: Tell users when a Workspace needs the format upgrade. The Workspace page and chat show a banner with the next step. Sources and the connect flows say that the upgrade comes first, and they offer no Add until it is merged. A failed upgrade toast shows its cause and offers Ask the agent or Open Upgrades, not a blind retry. Always update answers at once: the server saves the setting and then starts the upgrade, and a file job whose run ended with an error now reports `failed` with its cause.
- 75b0622: Git `merge-base` and `merge-tree` answers with exit code 1 ("not an ancestor", "conflict") no longer log `git.command_failed`. Real Git failures still log.
- 5e20502: GitHub: a connection that stores a copy of the deployment App's credentials uses the current `GITHUB_PRIVATE_KEY` and `GITHUB_WEBHOOK_SECRET`. Before, it used the old copy, so after a key rotation GitHub refused each request for the connection ("A JSON web token could not be decoded"), and the old webhook secret still worked on the connection's webhook URL. A connection with its own App keeps its own credentials.
- e916b10: GitHub connect no longer needs a linked GitHub account. When the linked account does not show access to the installation, the user authorizes the GitHub App one time, and ctxpipe makes no account link. `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET` must be the client ID and secret of the GitHub App in `GITHUB_APP_ID`, and the App must list the callback URL `{AUTH_BASE_URL}/.auth/api/v1/auth/callback/github`.
- 8ffab86: When the graph of a Workspace fails, the graph pane shows a Try again action. It builds the graph of the active revision again from PostgreSQL, at most once in each UTC hour, and only when the other parts of the Workspace are ready. It never hydrates a new commit.
- 31aad95: When `MODEL_HIGH_NAME` is unset, the high tier uses GPT-6 Luna with xhigh reasoning (`openai/gpt-6-luna?reasoning.effort=xhigh`), not Xiaomi MiMo-V2.6-Pro.
  
  With this default, all three tiers use the same base model, so the default OpenRouter fallback chain has no model from another vendor.
- e0d36f1: Hydrate: the `claims_upgrade` write job no longer adds a claim with only `to` to a file that ingestion v2 owns. The v2 validator refuses such a claim, so each later ingestion step that kept the front matter of the file failed. The job now removes each claim with no evidence from such a file. A body link still makes its `LINKS_TO` edge.
- 3200288: Hydrate skips text that only looks like a URL (a template or a placeholder host) with no warning. It no longer logs "A URL reference was skipped: Invalid URL" for the same files on each run.
- a0984ec: Workspace hydrate: the check for renamed files reads no file when the commit renames none. A connector commit in a Workspace with thousands of files no longer reads each file of both revisions, which took about two minutes of worker CPU for each commit (CTX-1369).
- 430133c: Hydrate: the rename rewrite of a large Workspace no longer blocks the workflow worker for seconds. The step that plans the remaining writes parsed each Markdown file in one synchronous loop. On a test Workspace with about 9,000 Markdown files, this loop blocked the worker for 4.6 s, and the block grows with the file count. A long block stops the 30 s workflow lease heartbeat, so a second execution of a hydrate or ingestion run can start. Now the rewrite does no work when no file was renamed, parses the previous version of a file only when that file was renamed, and gives the worker a turn every 50 ms.
- 0194542: Chat answers no longer show "[blocked]" after a file link that has a line anchor or a file: URL.
- 10d54ec: The service images now build from base images that are pinned to an exact tag and digest. The codesearch image builds Zoekt with Go 1.27.3, because Go 1.24 is no longer supported.
- d31c324: Ingestion v2: when the patch validator rejects a claim that matches no claim schema, the reason now names the field that fails (for example `claims.0.evidence.kind: invalid_value`), not only `claims.0: invalid_union`. For unknown keys, the reason gives the count of keys, not their names.
- d2c1bdd: The ingest patch validator accepts the host field `valid_from` on a claim. It ignores the value that a step writes, and copies the value of the base claim with the same target and predicate.
- b57267e: Ingestion v2: a later ingest of a source now finds the context files of each root. Before, the roots map listed only the files that a step of the same run wrote. A later ingest wrote no new Service file, so `dependencies` wrote no claim, and `libraries`, `ownership`, `decisions`, and `instruction-areas` did not find the file of a root. The host now adds each existing package file whose front matter `root` is the root and whose `sources` hold the source path. When the run wrote a package file of a root, an old package file of the same root is not added. The host runs the `dependencies` scan first, and starts the model only when a root has a candidate and a Service file. Each `dependencies` step also records counts of candidates, resolutions, and skipped choices on its span. `apply.mjs` no longer stops with an error at more than 300 resolutions.
- abe81c3: A `dependencies` ingest step that the scan gate stops reports a zero model usage. It no longer logs `ingestion-v2.usage-unknown` or marks the spend of the run as unknown.
- 6d9e17e: Ingestion v2: a publish no longer withholds a merged file because an earlier run of the same source stamped the file with another `source_sha`. The merge gives each merged file the host fields of the file on its base, and the validator stamps them again. A merge of more than 30 files no longer loses files to an op cap.
- 4823dd7: Ingestion v2: a publish that withholds merged files now logs the validator rule and reason of those files: one `ingestion-v2.publish-withheld` event for each rule and reason, with the count of files and no path. A `front_matter` withhold then names the field that fails.
- 07bb792: Ingestion v2: when a publish merges with a newer Workspace revision and a merged file fails the patch validator, the publish no longer drops all ops of the run. The publish withholds only the refused files, which keep the version on the default branch, and the other files publish. The Workspace is `partial` and its output names each withheld file and its validator rules. The `ingestion.run` span has a `ctxpipe.ingest.withheld` count. The `ingestion-v2.partial` log event of a publish now has the event name in `step`, the Workspace in `workspaceId`, and the fixed rule codes in `rules`.
- 096832f: An ingest run no longer fails when a deploy changes the ingest skill bundle while it runs. The run goes on with the new bundle, and it keeps each finished step.
- 310ecb5: A failed ingest step attempt now logs the kind of a failed fetch ("fetch failed" or "terminated") and the code of its cause, for example `UND_ERR_SOCKET`.
- 531ff8f: Ingestion v2: a shard child that runs twice no longer makes assemble fail with "The shard ref 0 is not at the given tip". Assemble takes each shard tip from the shard ref, when the ref holds a later commit of the run. Before each attempt, a step reads its ref back from the tip that it starts from. When the other execution pushed the step, the step takes that commit with no model run. When the other execution moved the ref, the step continues from its tip, so later steps do not end partial one after another. Publish takes the tip of the assembled ref, so it does not drop commits of the other execution.
- f1ec4d1: Ingestion v2: a push run that waits for its publish turn now ends when a newer push run of the same source is active. It ends before it calls a model, with the status `skipped` and the reason `superseded`. The newer run targets the same Workspaces, and its commit includes the older one. A re-ingestion run is never replaced. Thus several pushes in a short time give fewer paid runs, and fewer runs that publish over each other.
- 730c963: Ingestion v2: a stale execution of a workflow run stops before its next step attempt. When a worker does not extend the lease of a run in time, another worker starts a second execution of the run. Before, the first execution continued and made its own model calls for up to three attempts of the step. Now each step attempt first makes sure that its execution still owns the run. If it does not, the step makes no model call, and the worker logs `ingestion-v2.execution-lease-lost`. A stale execution does no cleanup while another execution owns the run. The live execution uses the same scratch folders and cleans them up. After a cancel, the run releases its scratch folders at once. When the worker cannot read the run, the step continues and logs `ingestion-v2.execution-lease-check-failed`. Each step event now has the execution attempt (`executionAttempt`) when the worker knows it, and the `ingestion.step` span has `openworkflow.execution.attempt`. With these values, a query can drop the events of a stale execution. The span also records an adoption of the work of another execution (`ctxpipe.ingest.adopted`). It keeps `error.type` only when the step ends partial. A failed lease extension now writes the log event `openworkflow.lease_extend_failed`.
- 2cff34f: Ingest: a model step that runs close to the 10-minute step limit now stops its model one minute before the limit and keeps the files that it staged as a page. The next page continues from them. Before, the limit ended the step, the step lost its work, and the retry started again from the start.
- 9d739ef: Knowledge search: a Markdown section that holds only its heading line now joins the next section, and in a section over the size cap a paragraph of only headings stays with the next paragraph. Thus no search hit shows only a heading. When hydrate or the knowledge plane projects a unit again, it embeds again only the changed chunks of that unit: the chunk after each heading-only section, and the chunks of a long section whose heading was its own chunk. A heading-only chunk at the end of a unit is deleted. MCP read-tool spans now record the argument names, the query length, the result count, and the top score, but no query text.
- ba9f2cc: The knowledge plane converts PDF, DOCX, PPTX, XLSX, HTML and SVG files and images to text at projection time. The worker image now holds the file converter (`ctxpipe-convert`). A new ClickHouse table, `image_texts`, keeps the readings of the vision model.
  
  One vision model reads the images. The default is `openai/gpt-6.1-terra`; set `MODEL_VISION_NAME` to use another OpenRouter model that takes image input and has a ZDR endpoint.
- 022b044: A knowledge projection run whose step stopped the worker three times (for example, out of memory) now fails with the crash-loop error, and no worker claims the run again. The error event `openworkflow.step-crash-loop` names the workflow. The next hydrate or push of the Workspace starts a new projection run.
- 1368258: The knowledge projection writes the files of a Workspace in groups of at most 2 MiB of file content, not 1,000 files. A group of 1,000 large files (for example mirrored issues) held more than 1 GiB in the worker until its insert, and the worker of a 2 GiB task stopped. A file above 2 MiB is a group alone.
- c6c07b7: Knowledge plane: `get_related` now also returns each document on the path from a seed to a result that answers the question. Before, the loop explored such a middle document and found the far document through it, and then dropped the middle document because it did not answer the question alone. A step keeps its own relevance score, so it comes after the results that answer. The disagreement positions still compare only the results that answer.
- 0e1e0b6: A Workspace upgrade and a Workspace write no longer fail with "stdout maxBuffer length exceeded" on a large Workspace repository. ctxpipe now writes the Git pack and the large Git outputs of the format 3 upgrade (the file list, the Markdown files and their history) to temporary files. A Git pack larger than 190 MiB gives a clear error. A Git command that takes too long gives a known timeout error. The upgrade card names these causes and gives a next step, and the worker logs each failed upgrade.
- 91d05b7: Chat answers now link a file name only to a file that is in the conversation git tree. A bare name with no match stays as text. There is nothing to configure and no migration.
- a451328: Knowledge from before Workspaces needs the format upgrade and the re-ingestion. The new knowledge store reads only the Workspace repository, and a later release removes the old knowledge stack that serves this knowledge from the database. The Upgrades card of each Workspace now shows the count of knowledge files that are not in the repository. When the new knowledge store serves such a Workspace, the MCP knowledge tools give a notice with the same count and action. Before you deploy the release that removes the old stack, merge the format upgrade of each Workspace, then start its re-ingestion. See "Knowledge from before Workspaces needs the re-ingestion" on the self-hosting upgrades page.
- dfc310c: The full-text side of the knowledge search uses its GIN index again for the app role. Before, row-level security prevented the use of the index, so each search read all chunks in its scope.
- a248504: The full-text index of the knowledge search holds the org too, so one index scan serves the org and the match, also when the search terms are common in other orgs. Each migrate logs the plan of that match as the app role.
- 3118582: The full-text side of the knowledge search reads only the matches of the searched Workspaces, through a GIN index by org and Workspace, not every match of the org. Migrate builds the new index without blocking writes.
- f1f441e: Fix the Linear token refresh. A Linear connection whose access token had expired failed on every call, so the source editor and Linear source syncs stopped.
- cce8e3f: An MCP code call rides over a codesearch redeploy: connection refused and name not found retry until the call's 20 s deadline.
- 4932c41: Migrate waits at most 5 s for a database lock and tries again, so a deploy no longer fails while the old services run. A failed migrate names the Postgres statement and table.
- e9c065f: The service images (backend, worker, UI, codesearch, chat sandbox) now publish for linux/amd64 and linux/arm64 under the same tag.
- 84a1bba: The service images and the chat sandbox image now use Node 26.13.1, the current Node LTS release.
  
  Upgrade: run `pnpm update @ctxpipe/aws-cdk`, then `cdk deploy`. There are no new props. If you run the Docker Compose stack, run `docker compose build --pull` to build the images on the new base images.
- bfe06ff: The floating panels over the knowledge graph have an opaque surface, so graph lines and labels do not show through their text.
- ebabc71: A Workspace hydrate now writes only the knowledge units, chunks and graph nodes and edges that changed since the last hydrate. A full hydrate stays the fallback. One hydrate of a Workspace runs at a time, and each run hydrates the current tip of the branch.
- 84e3ef9: The backend writes model call spans as plain OpenTelemetry spans with the GenAI keys and has no Langfuse dependency (merge after the AWS cutover).
- c119cfc: The OpenWorkflow worker no longer exits when idle, and the backend no longer wakes a Railway worker after an enqueue.
- df75434: Hosted chat and ingest sandboxes run only on AgentCore now, so the Vercel Sandbox provider, its hosted Workspace bases, and its ingest egress proxy are removed. The backend and the worker refuse to start while a sandbox row of the Vercel provider stays; the sandbox sweep of the release before this one removes those rows. That sweep step (the Vercel sandbox retirement) and its S3 bundle path for refused commits (`RETIRED_SANDBOX_BUCKET`) are removed too.
- 63ceb62: The product text now says "ctxpipe" instead of "ctx|". The UI, the docs, the CLI, and the emails show the new name. Only the logo keeps "ctx|".
- 6bb3340: Fix the knowledge files that a Workspace upgrade writes: every value now parses, so hydrate no longer skips them. Workspace settings and Home list every skipped file. A skipped file of knowledge from before Workspaces shows its cause and has no "Fix using agent" button.
- 7631c4c: The backend and worker images trust the Amazon RDS CA bundle (`NODE_EXTRA_CA_CERTS`). A database URL that asks for a verified TLS connection (`sslmode=verify-full`) to Aurora now passes the certificate check. The database URLs of the construct do not change.
- 39ac3a3: Operator jobs: a ban of a user (the `banned`, `ban_reason` and `ban_expires` fields) stops each sign-in and each credential of the user. Migrate makes the `ctxpipe_console` role, which can only queue the `admin.*` jobs and read views with no secret column.
- 862b07e: A re-ingestion upgrade that fails for a temporary cause starts again by itself, once.
- 6eb1bac: Repository indexing: stop the hourly codesearch rebuild of a private repository that has no GitHub connection. Git asks for a credential, so the run records that ctxpipe has no access, and the Workspace sources list shows the fix. The rebuild tries again after one week (CTX-1717).
- cdc7998: Repository indexing: stop the hourly codesearch rebuild of a repository after GitHub refuses ctxpipe access to it. The Workspace sources list shows the repository as not indexed, with the fix. The repository indexes again when the installation gets it back, when the user refreshes the Workspace, or after one week (CTX-1297).
- 5a9c66b: Workspaces: "Try again" on a Workspace prepare starts a new prepare only when the prepare failed or has no tip. A retry in a different state gets 409 and changes nothing. A prepare that has no tip accepts one retry in each minute. A retry of a revision that is already published sets the Workspace ready again.
- b4efc58: A connector mirror write that loses a push race goes to the semantic merge again, as before #567. The replay of #567 failed for about 45% of the writes in a burst.
- 475f0b7: Fix the boot of the sandbox host, which made a fresh deploy fail at the sandbox host Auto Scaling group. The host firewall refused the replies to the host's own check of Agent Vault, and that check did not retry a connection reset while Agent Vault starts. The host now refuses only new connections from the Agent Vault network, and the checks retry every error.
  
  Sandboxes can now reach the Agent Vault proxy (TCP 14322) on the host. Before this fix, the host firewall refused that connection.
- 813f4f9: The sandbox host forwards Agent Vault's proxy port without docker-proxy and without NAT for sandboxes. Agent Vault now sees the address of each sandbox. Before, it saw one address for all sandboxes, so 50 failed proxy logins from one sandbox blocked the proxy for all sandboxes for up to 5 minutes. The next deploy replaces the sandbox host (rolling update), so running sandboxes on it stop.
- 91f964e: A daily source sync that waits for its start time no longer shows as "Syncing" in Workspace settings. A sync that waits to retry still shows.
- 9543556: The UI server render now calls the backend on its Cloud Map address (`http://backend.ctxpipe.local:3000`), not through the load balancer. Better Auth then sees the address of each browser, and the auth rate limit counts each browser. The UI gets `AUTH_ALLOWED_ORIGINS` set to the public app URL, and the app security group allows the backend port 3000.
- 7bc0e63: A Workspace write no longer fails when the merge model reaches its time limit. The merge asks the model about one conflicting file at a time and asks again a few times. If the model still gives no usable answer for a Markdown file, the write keeps both versions of that file in Git conflict markers. Hydrate skips that file and shows it as a skipped file with a "Fix using agent" action. Remove the markers to finish the merge. For a file that is not Markdown, or a file that one side deleted, the write fails with its cause.
- 7abbba5: The semantic side of the knowledge search reads the HNSW index of the embeddings, now in half precision, for a large scope, instead of the distance of every chunk in scope. Migrate builds the new index without blocking writes.
- cd6525e: The backend can send email through the Amazon SES v2 API with the AWS credentials of its process (`EMAIL_TRANSPORT=ses`). SMTP stays the default.
- ab079df: Make the connector setup dialogs consistent: one link style, one loading line, and the same step names.
- 6473f5b: A new chat, or a move to a different conversation, no longer opens the file or diff pane of the last conversation. A file pane now opens the Files pane, and a diff pane closes. The Files, Graph, and Settings panes stay open.
- 9adfe60: Worker: each worker start queues the sandbox sweep backstop with the same hourly key as the tip check. Many worker starts in one hour now share one sweep for each org, not one sweep for each start (CTX-1305).
- 4a2657b: Fix the two-factor setup error. A new migration adds three nullable columns to the `two_factors` table, so a user can turn on two-factor sign-in. A second migration marks the factor rows of users who did not finish the setup as unverified, so that they can set up two-factor again. The same migration turns two-factor off for users who have it on but have no stored factor. These users enabled two-factor again, and the error deleted their stored factor, so they could not sign in. After the migration, they sign in with a password and set up two-factor again. The lost factor cannot be recovered.
- 9318ff6: Build the package with TypeScript 6.
- 26a45dc: The UI answers a page request that has no session cookie with a redirect to sign-in, and it does not ask the backend. When the backend rate-limits the session check, the org pages also redirect to sign-in. A scanner burst no longer makes server-render errors (part of CTX-1317).
- cbaadfe: The welcome slide shows each step label as a label again: a gap separates the teal number from the word, and the word is muted, so the body text stays the content. On the user account and organization settings pages, the page title is larger than the card titles under it.
- 2ce3461: The Connectors page shows each connection as a tile. The head of the tile opens its details, and "Add connection" is a labeled button. A connector status has its color on the dot only, in one aligned column, also in the Add connection dialog. Each setup dialog has a header, a body and a footer with one Close button, and "Merge the pull request" is a card in the setup steps. The API key dialog has the Copy button in the key field and says that ctxpipe shows the key one time. Every warning, also the format-upgrade banner, is a dark surface with a yellow border and a yellow icon, with its actions on the right. The graph legends are smaller and muted. The chat thread uses the column of the composer. The file tree text is brighter. A page error gives the cause and the next step. The setup dialogs fit the screen with a fixed header and footer, and long text wraps inside alerts and cards. The file viewer and the diff use the dark theme. A connector tile and every other card have a surface that is lighter than the page. A scope list in a setup dialog keeps its frame. In a Workspace settings card that needs you, a blocked or failed upgrade shows its problem as quiet text with its fix next to it, without a second warning box. Each problem in a settings card is one line with its icon and its fix, and a slow write access check shows as a neutral wait. The Confluence capabilities warning is one short sentence, with the technical detail behind "Show details".
- 95f1531: The product UI is quieter. A quiet button shows a background wash on hover, not a teal glow. A status dot pulses only while work runs. No text is smaller than 12 px. Empty states have no icon tile, page titles have no mono eyebrow label, and the settings cards have no corner crosses.
- 2e9825d: When a user signs in with an email that is not verified, the sign-in page shows "Verify your email to sign in" as an information toast, not as an error toast. ctxpipe sends a new verification link at that time.
- dec9e7d: The service images now use Bun 1.4.4 and Node 24.22.1, and the chat sandbox image uses Node 24.22.1 with the updated Debian `ca-certificates`. The custom-resource Lambda functions now run on Node.js 24 (`nodejs24.x`). These releases no longer trust eight eMudhra intermediate CA certificates that the root programs removed in October 2026. The older images still accept TLS connections through those intermediates.
  
  Upgrade: run `pnpm update @ctxpipe/aws-cdk`, then `cdk deploy`. There are no new props. If you run the Docker Compose stack, run `docker compose build --pull` to build the images on the new base images.
- 7bff4c4: A Workspace format upgrade no longer fails with "spawn git EAGAIN". ctxpipe now runs at most eight Git processes at one time, and it starts a Git process again when the server refuses it for a short time. If the server stays busy, the upgrade card names the cause and tells the user to start the upgrade again.
- 99ed185: The Home upgrade toast shows a title and one short line, and it holds no space when it goes. The full description stays in Workspace settings, Upgrades. After the format upgrade merges, the re-ingestion item says that ctxpipe is checking the new format, and the page reads the items again by itself. The blocked copy of the re-ingestion is short and gives one action.
- cfd1629: Show the progress of an upgrade in Workspace settings: the stage, the step count and the time so far while ctx| prepares the pull request, and a merged state after the pull request merges. Check again now shows when ctx| checked and what it found. Reading the Workspace history after a merge or in an upgrade is faster.
- 1262263: The OpenWorkflow worker no longer restarts again and again on one ingestion step. The worker keeps only a bounded part of each sandbox command output and refuses a step output over 4 MiB before it reads it. A skill step that stops the worker three times in 2 hours now ends `partial` with its cause, and the run goes on with the next step. The worker supervisor sends SIGTERM and SIGINT on to the worker, so the worker stops cleanly on a deploy. The worker image runs its supervisor and the worker under Node, not Bun. On SIGTERM, the worker marks the step attempts that it runs as failed, so a deploy does not count as a crash. Then it stops at once and starts no new step; the next worker runs the marked steps again. A skill step costs nothing for this. An `ensure-sandbox` step loses one of its 2 retries, but only when a real failure comes after the deploy. The worker container now gets 30 seconds from SIGTERM to SIGKILL (ECS `stopTimeout`, Compose `stop_grace_period`), and the supervisor kills the worker after 25 seconds.
- 2f935cc: The worker reads its memory limit from its cgroup, also when the limit is on a parent cgroup, as on ECS and Fargate. Before, a Fargate worker got a Node heap limit from the host memory, above its task memory, so the platform stopped the container before Node could fail with a heap error. The worker also logs the error `openworkflow.memory-near-limit`, which names the running ingestion steps, when it nears its heap or container memory limit.
- 260e2c5: The worker now sets its Node heap limit from the memory of its container (about 55%, up to 12 GiB), so a large ingestion no longer stops at the default 4 GB limit. The worker also writes a heap snapshot to `/tmp/heap` before an out-of-memory exit. No action is needed. To use another limit, set `--max-old-space-size` in `NODE_OPTIONS` on the worker task.
- 36e67e4: The backend and worker images install libatomic, which the copied Node 26 binary needs on x86_64; the build runs `node --version`.
- 837d2c9: The OpenWorkflow worker reports its queue depth as the OpenTelemetry gauge `openworkflow.queue.depth`. A hosted deployment (`DEPLOYMENT_ENVIRONMENT` set) also writes the depth as the CloudWatch metric `ctxpipe` / `WorkerQueueDepth` (Embedded Metric Format on stdout).
- f1e0393: Show when a Workspace ingests. Its row in the sidebar shows a teal pulse with the text "Ingesting N sources". Workspace settings has an "Ingesting now" list with the stage, the progress and the time so far of each repository run and connector sync. A run that waits for an earlier run of the same repository shows that it waits. A slow hydrate of the newest commit shows as one line.
- f72c73a: Workspace settings: one card for each part (Upgrades, Sources, Knowledge graph, Repository, Workspace, Danger zone). A line at the top names the parts that need you and the parts at work, with a link to each card. Each source shows its live work in its own row (for example "Publishing" and the time), and its runs open under it, so the separate "Ingesting now" list is gone. A source with a problem shows the problem, also while it syncs. Automatic upgrades is a switch. The upgrade history shows the five newest upgrades, and each one opens to its detail. Links are teal, not blue.
- ab898fb: Workspace settings now starts with a Status group. Its first line tells if you must act: "Needs you", "Working" (no action needed), or "Up to date". Upgrades that wait for a person show under "Needs you". Upgrades that ctxpipe works on show under "Working now", with the spend so far of a re-ingestion. A format file that ctxpipe cannot read also shows "Needs you". The group shows the automatic-upgrades setting, and an owner or admin can turn it on or off there. History shows the count of applied upgrades and the date of the last one.
- e04b1d5: A Workspace write whose push loses the race at the remote merges again instead of failing its step, and a failed push logs the rejected refs and their reasons.
- e825d70: A failed first deploy can roll back and be deleted cleanly. The database URL writer returned a fixed physical id on delete, so CloudFormation ended in `ROLLBACK_FAILED`. It now returns the id that CloudFormation holds. No action is needed.
- 58461b7: A Confluence source with more than 500 pages in one space shows the cap message again, not "Invalid input". The upgrade of a legacy Confluence connection splits a long page list into more than one source entry again.

## 3.3.0

### Minor Changes

- df99abc: Add `sandboxHost.agentVaultNetworkAllowlist`. Agent Vault on the sandbox host can then connect to a private git server, so ingestion can read a plain git repository from it. The stack adds each entry after the backend subnets. Synth rejects an entry that is not an IP address or CIDR, and an entry with a cloud metadata, link-local, loopback, or unspecified address, or a range that covers one.
- df99abc: Provision a `ctxpipe_app` Postgres role on `cdk deploy` and point runtime `DATABASE_URL` at it. Existing stacks keep the same `CtxPipe` props: bump `@ctxpipe/aws-cdk` and redeploy.
- df99abc: Git-backed Workspaces: each Workspace keeps its knowledge in a git repository. It links code repositories for search. Each Workspace has Workspace chat with Files, Diff, and Graph panes. Connectors write into a Workspace.

  New chat sandbox host: Workspace chat runs each conversation in its own Docker container. The containers run on a new EC2 host. `CtxPipe` creates this host unless you set `sandboxHost: { enabled: false }`.

  The host is a Graviton instance. The `size` prop selects `t4g.medium`, `t4g.large`, or `t4g.xlarge`. The Docker volume is 30, 50, or 100 GB. The cost is about $28, $54, or $107 a month in us-east-1.

  Docker runs over mutual TLS. The certificates are in Secrets Manager. CloudWatch alarms watch Docker disk and memory (`sandboxHostAlarms`).

  Two optional props change the host size: `sandboxHost.instanceType` (Graviton only) and `sandboxHost.dockerVolumeSizeGiB`.

  The host pulls the chat image `ghcr.io/ctxpipe-ai/chat-sandbox` on the first chat after a release. Each release publishes this image. Thus a release does not replace the host.

  Upgrade: there are no new required props. Run `pnpm update @ctxpipe/aws-cdk`, then `cdk deploy`. The upgrade only adds resources. It replaces nothing that holds data. It waits until the host is ready, then it rolls backend and worker.

- df99abc: The public MCP server at `/mcp` has new read-only tools: `list_workspaces`, `search_knowledge`, `search_code`, `find_symbol`, `read_file`, `list_files`, and `get_related`. The tool `ctx_advisor` is removed, so an MCP client that calls it must call the new tools. Each tool call names one organization with the `org` argument. An OAuth grant holds a set of organizations, and the user changes the set on the new Connected apps page. The server ignores the `?orgSlug=` URL parameter. The scopes are `ctxpipe:read` and `ctxpipe:write`.

  Upgrade: there are no new required props. Run `pnpm update @ctxpipe/aws-cdk`, then `cdk deploy`. The release runs database migrations for the organization sets and the knowledge search tables.

- df99abc: The sandbox host runs Agent Vault, which adds the credentials of chat sandboxes to their requests. Sandboxes hold no GitHub token or backend credential, and they reach the network only through the Agent Vault proxy (HTTP and HTTPS stay open). The stack generates the Agent Vault passwords in Secrets Manager and gives the owner password to the backend and the worker.
- df99abc: This release adds the chat sandbox host. It is on by default. To turn it off, set `sandboxHost: { enabled: false }`. Chat is off without the host.

  The default size (`size: "small"`) is one `t4g.medium` instance. It costs about $28 a month in us-east-1. The `medium` and `large` sizes cost about $54 and $107 a month.

  The first `cdk deploy` adds the host. It replaces nothing that holds data.

  Before you upgrade, set the GitHub App repository permissions to `Read and write` for `Contents` and `Pull requests`. Accept the changes for each installation.

  There are no new required props. Run `pnpm update @ctxpipe/aws-cdk`, then `cdk deploy`.

  The migrate task now runs the single migrate entry point. This entry point makes `ctxpipe_app` ready, applies the expand-only SQL, and runs the backfills.

  Before you upgrade, take a database snapshot. To roll back, restore the previous package version and the owner `DATABASE_URL` secret. See the Upgrades page.

### Patch Changes

- df99abc: A new Workspace on a GitHub repository that has no ctx| content now starts at the current format. An example is a new repository that you made with "Add a README". Before, such a Workspace started at format 0 and refused new sources until you ran the upgrade. Bootstrap now adds one commit with its files and `.ctxpipe/workspace.yaml`, and keeps the files that are there. A repository that has `.ctxpipe/`, `sources/` or `repositories/` keeps its format and gets the upgrade as before.
- df99abc: The first chat turn in a new conversation is faster. The final event no longer waits for the conversation title, and the first message uses the WebSocket that the page opened before.
- df99abc: A chat answer starts sooner. The chat agent no longer copies the repository for its own undo, watches its files, or builds a file search index before its first model call in each turn.

  The backend also stops reconnecting to the chat agent of a finished turn after that agent stops.

- df99abc: Workspace chat answers with fewer exploring steps. The agent gets a short summary of the Workspace: the searchable repositories and the largest knowledge folders with their file counts. The summary never lists file names and stays under 2,000 characters. A new conversation starts its sandbox when the composer gets focus, so the first turn waits less. Traces show the reasoning effort of each model call.
- df99abc: The first chat turn in a new Workspace no longer fails with "signal timed out". The browser now waits up to 4 minutes for the chat sandbox. A new hosted sandbox can take more than 30 seconds to start.
- df99abc: Add ast-grep and ripgrep to the chat sandbox image for the ingest skills.
- df99abc: Fix plain-HTTP Node fetch through the egress proxy in the chat sandbox image.
- df99abc: Codesearch opens a file without following a symlink at its last part. On Linux, it checks the opened file again before it reads it. The TypeScript indexer never writes through a symlink. The SCIP index keeps only documents inside the checkout and outside `.git`.
- 3130db7: Keep codesearch reads and searches inside the checkout and out of `.git`. Structural search uses the codesearch ast-grep config, not a config file from the repository.
- df99abc: Docker Compose: the `deploy` profile no longer publishes Postgres on host port 5433 (`CTXPIPE_POSTGRES_HOST_PORT`). If a backup job or a tool on the host used that port, run it through Compose, for example `docker compose exec postgres pg_dump -U ctxpipe ctxpipe > backup.sql`. The `infra` profile for local development still publishes the port.
- df99abc: API keys and read-only OAuth tokens now get 403 on routes that write directly to a Workspace. These routes need a signed-in session or an OAuth token with the `ctxpipe:write` scope.
- 841f2bd: Email/password accounts verify their email address before signing in when SMTP is configured. Unverified accounts are sent a fresh link when they sign in.
- df99abc: Pass the public auth origin to the UI task for browser telemetry
- 2efdf5f: GitHub connections that store a copy of the deployment App's credentials get the deployment App's webhooks again. A push starts re-ingestion, and a merged connector configuration pull request starts the connector sync.
- 6cdf18b: Attaching a GitHub installation now requires a linked GitHub account that can see it, or the organization's own App.
- df99abc: When you remove a GitHub connection, each Workspace that used it now shows a failed hydrate that tells you to reconnect GitHub. Before, the Workspace stayed in "pending" with no job to move it. When you connect GitHub, ctxpipe binds each GitHub Workspace that has no connection and whose repository the installation can read, and starts hydrate again. This includes Workspaces that you added by pasting a URL.
- e4e24ad: License the self-host construct under MIT, matching the repository.
- df99abc: Add Workspace no longer asks for an upgrade on a repository with no ctx| content. Before, a read of the repository before the bootstrap commit showed format 0 for a short time, and the form showed "Upgrade this Workspace before you add sources". The form now waits for the bootstrap commit, which sets the current format.
- df99abc: The migrate task runs the same steps and backfills as Docker Compose and the hosted deploy. When the `ctxpipe_app` role does not exist and no password is given, migrate stops with exit code 1 before it changes the database, and it tells you how to fix it.
- df99abc: Ingestion v2 reads a git repository that has no GitHub connection and needs no credential, as the old ingestion did. A plain git source file under `sources/git/` links it to a Workspace, and the format upgrade adds one for each such organization repository. ctx| reads it with no credential, checks the addresses of its host, follows no redirect, and reads no system or global git config. The sandbox can fetch only that repository path, and only while it prepares the source. A self-hosted deployment with Docker sandboxes (`SANDBOX_PROVIDER=docker`) keeps the behavior of main: a plain git URL can use `http://`, another port, an IP address, or an internal host, and the backend reads it with no credential and no redirect, through the proxy of its environment if there is one. Hosted ctx| and each other deployment read only public `https://` URLs on the default port. In each deployment, ssh, `git://`, and `file://` are not supported.
- df99abc: You can add a plain git repository to a Workspace by its https URL. In Workspace settings > Sources, open Add repositories and use the Paste URL tab. ctx| checks the URL with the plain git URL policy and opens a pull request that adds the source file under `sources/git/`. When the pull request merges, the first ingestion of the repository starts.
- 32fe59f: Strip characters Postgres jsonb cannot store from package extract results, so a step write is not rejected and retried.
- df99abc: A Workspace re-ingestion now waits while an ingestion run of one of its source repositories is active, so that its publish does not need a merge with that run. A failed upgrade now shows the step that failed, the cause in plain words, and the action that fixes it.
- df99abc: The runtime services read `DATABASE_URL` from a new `RuntimeDatabaseUrlSecret`, which holds the `ctxpipe_app` URL. `DatabaseUrlSecret` keeps the owner URL, as in earlier releases, and the migrate task reads it. If ECS or CloudFormation rolls back to the task definitions of an earlier release, those tasks start on the owner URL and see every row. Migrate also makes the webhook directory agree with the connections on each deploy, so connections that an earlier release added or deleted during a rollback get their webhooks again.
- 494f8d7: Accept a long TypeScript SCIP index immediately and read the result back, so a headers timeout does not fail an index that is still running.
- f415e4d: Upgrade TanStack Start past the reflected cross-site scripting fix so docs previews and the product UI are on a patched release.
- df99abc: The backend and worker images refuse `SANDBOX_PROVIDER=unsandboxed`. An unsandboxed agent runs only in local development, and it gets only an allow-list of the backend's environment variables.
- df99abc: A Workspace now gets its sandbox base. Before, the base build failed with "getLogger: no logger in context", so no Workspace got a base.

## 3.2.0

### Minor Changes

- ce5f396: Optional `otel` prop: one OTLP/HTTP base URL; the construct sets per-signal `OTEL_EXPORTER_OTLP_*_ENDPOINT`, headers (Secrets Manager), and `OTEL_SERVICE_NAME` on the backend, worker, UI, and codesearch tasks. No collector is deployed.

### Patch Changes

- 58b47fa: The backend and worker images run on Bun 1.4.2. Reading streamed model responses costs several times less CPU than on Bun 1.3, so concurrent advisor requests no longer saturate a small backend task. Bun 1.4 checks TLS certificates against the connection host: if `DATABASE_URL` or `GRAPH_DB_URI` reaches a TLS server by IP address or through a `localhost` port-forward, use the hostname on its certificate.
- 93ab07f: Default chat tiers are GPT-6 Luna with high reasoning (fast), GPT-6 Luna with xhigh reasoning (medium), and Xiaomi MiMo-V2.6-Pro (high) when `MODEL_*_NAME` is unset.
- c22338c: Read Linear through budgeted GraphQL documents: one request per page, a workflow step per page, and one git commit at the end. UTF-8 GitHub writes go in chunked trees instead of one blob post per file. A connector stays Syncing until indexing finishes.
- 3ec176f: Backend logs export to the OTLP collector in background batches, and the UI telemetry relay times out after 2s. A slow or unreachable collector no longer delays API responses.
- cca4146: Index every TypeScript project, including the root, in its own `scip-typescript` run (parents exclude nested project directories), with workspace packages linked into a temporary `node_modules`, a heap sized from the memory share, and wire-level shard merges. Partially failed TypeScript indexes report `complete_with_issues` with a short reason; repositories where TypeScript is only an incidental nested config soft-skip instead of failing. Graph queries load SCIP one document at a time, and monorepo packages gain `PART_OF` edges to their enclosing package.

## 3.1.14

### Patch Changes

- 6d6c5dc: Answer from the tool results gathered so far when ctx_advisor's tool loop reaches its step limit, instead of failing the call. Each tool call and its error is logged on the process logger, and the advisor rephrases an empty search or fixes a failed call at most once.

## 3.1.13

### Patch Changes

- 9ca0146: Get local memory into git and the graph. The Stop hook, `memory status` and `memory doctor` now report durable `.ai/memory` files left uncommitted, and the installed rule and skills tell agents to commit memory with the work it came from and to summarize that work in the pull request description. `memory init` now also installs the memory rule and skills for Claude Code (`.claude/rules/`, `.claude/skills/`), capture hooks for VS Code (`.github/hooks/ctxpipe-memory.json`) and a capture plugin for OpenCode (`.opencode/plugins/ctxpipe-memory.js`); a Claude Code hook that Cursor or VS Code also runs now stands aside when that tool has its own, so capture runs once. Ingestion reads `.ai/memory/lessons-learned.md` as an instruction source (below `AGENTS.md`), and extracts instruction files over 48,000 characters in chunks (split at headings, then paragraphs) instead of truncating them. Lessons already committed reach the graph the next time the file changes or the repository is re-indexed. `memory init` no longer replaces a team's `.ai/memory/README.md` because it mentions the current `memory-search` skill, and capture no longer proposes a glossary entry whenever a message mentions the glossary.

## 3.1.12

### Patch Changes

- a745669: Start scoped-mirror sync when config.yaml already matches after a context-repo rebind, and keep connector ingest from dying without a logger.
- a974425: Stop organisation invites from 403ing when the browser is signed in as a different email than the invitation.

## 3.1.11

### Patch Changes

- 23b1ccf: Allow Bearer-only MCP hosts to present personal or organisation API keys after OAuth resolution fails, without enabling Bearer API-key authentication on REST. Keep organisation key minting in Organisation settings instead of the personal API keys dialog.
- 0ffa523: Fix GitHub pull-request graph ingestion and retraction, and deduplicate PR mirror startup and content-sync workflows.
- 8cbc8c8: Store Linear OAuth app credentials on the connection so self-host can register the Linear app in the product UI without `LINEAR_*` env. Hosted env remains the fallback.
- b22e75e: Let self-hosters register a public Notion integration in the product UI so empty `NOTION_*` env still connects and receives signed webhooks. Hosted keeps the env-owned one-click path.
- 3b7c44a: Add optional PagerDuty OAuth connector secrets for self-hosted deployments.

## 3.1.10

### Patch Changes

- 9c9e889: Add API-key MCP auth as an OAuth alternative: `--auth api-key` writes a client-specific interpolation of `CTXPIPE_API_KEY` (never the secret) into repo or user MCP config. Mint organisation keys in Organisation settings; personal keys remain under User account. `doctor mcp` sends `x-api-key` when `CTXPIPE_API_KEY` is set in that process. Raise dashboard API-key rate limits so MCP is usable.
- 8c1fbd2: Fix ctx_advisor on Neptune-backed AWS CDK deploys: graph traversal now uses openCypher `size()` list predicates instead of Neo4j `ALL()`, and advisor failures emit on the process logger so they survive a sealed request event.

## 3.1.9

### Patch Changes

- b5f0149: Wait for codesearch index capacity instead of failing the backlog after about ten minutes.
- 762dc52: Colocate hosted Railway with Neon in US East (IPv4-first org SQL).

## 3.1.8

### Patch Changes

- 5d55a4b: Make SCIP ingest optional with graceful degradation so Zoekt OOM skips SCIP langs and extract can still complete.

## 3.1.7

### Patch Changes

- 272432c: Make Forge production deployment use its built-in pre-deployment lint so scope-driven major versions cannot be blocked by a divergent standalone check.

## 3.1.6

### Patch Changes

- 5e29c73: Capture durable Slack, Linear, Notion, and Confluence assets in context repositories with bounded downloads and safe reconciliation.

## 3.1.5

### Patch Changes

- 041401e: Inject size-derived OpenWorkflow and codesearch indexer concurrency so a single codesearch replica is not overloaded when worker count grows.

## 3.1.4

### Patch Changes

- 6982d66: Fan out in-workflow repository ingestion with `step.runWorkflow` so parent workflows sleep and free concurrency slots while children run.

## 3.1.3

### Patch Changes

- d93a844: Pass Notion connector credentials to the self-hosted backend and worker services.

## 3.1.2

### Patch Changes

- 049e626: Add GitHub repository sorting and distinguish queued repositories from active indexing.
- 2456609: Ship explicit Slack app-mention permissions, installation diagnostics, and safe OAuth failure handling for hosted and self-hosted connectors.

## 3.1.1

### Patch Changes

- c7aef1e: Ship DB-only Linear and Notion status reads and stop stable connector-page polling to prevent GitHub throttling from exhausting PostgreSQL connections.
- 34f8818: Allow optional Slack app credentials (`SLACK_CLIENT_*`, `SLACK_SIGNING_SECRET`) in connector secrets for self-hosted ECS.

## 3.1.0

### Minor Changes

- b694aaa: Add the production-ready Notion connector, including scoped page and database mirroring, recursive child-page sync, GitHub-backed Markdown output, OAuth refresh handling, and app-level webhook-driven updates.
- b5dd479: Raise codesearch Fargate memory to 4/8/12 GiB on small/medium/large so ingest peaks fit. Upgrading this package and running `cdk deploy` also rolls pinned backend, worker, UI, codesearch, and migrate images: Zoekt-optional `complete_with_issues` ingest, the memory-fit error instead of `fetch failed`, and the Postgres enum migration (run automatically on deploy).
- 412a83d: Add the Git-native Linear connector, including OAuth, signed incremental webhooks, reviewable scope configuration, content mirroring, deployment wiring, and self-hosting support.
- b694aaa: Add Notion OAuth and webhook secret injection to the self-hosted AWS construct.

### Patch Changes

- 5423a9d: Fix invited-user onboarding so successful invitation acceptance joins the intended organization and failed acceptance remains visible instead of redirecting users to organization creation.
- 3e6bd1e: Make Git sources usable at hundreds of repositories (virtualised list and picker, merge-on-save) and unify the connectors list and setup wizard chrome.
- aa4987a: Select TypeScript SCIP only when a root `tsconfig.json` / `jsconfig.json` exists, so nested-only configs no longer schedule `scip-typescript` (and fail ingest) when the indexer always runs with cwd at checkout root.
- 52370f7: Require organisation membership for MCP and org-scoped REST. Harden Streamable HTTP transport and add ctxpipe doctor mcp plus version-pinned MCPJam diagnostic scripts.
- c07af15: Large-repository indexing reliability: SCIP/Zoekt phase orchestration, bounded indexer concurrency, tenant-safe Zoekt identity, safer indexer child env, durable repository deletion, and related ingestion scale fixes.
- 602f56c: Harden Linear and Notion connector setup sync edges: keep wizards on the merge step while config PRs are in flight, initialise empty GitHub repos before content commits, pass the binding branch into repository ingestion, and improve Linear mirror readability (names and private media placeholders).

## 3.0.2

### Patch Changes

- de67036: Improve chat, graph, and repository indexing UX.

## 3.0.1

### Patch Changes

- 7f9e003: Improve deterministic library extraction during code ingestion by adding manifest-based prepass detection across major ecosystems, running LLM fallback only for ambiguous roots, and preserving per-claim extraction provenance for deterministic vs LLM findings.
- 04c6fa9: Validate Bedrock embedding model IDs in `CtxPipe` so non-Cohere values fail fast at synth/deploy instead of causing runtime ingestion failures. Also treat blank `models.embedding` as unset and keep the default `cohere.embed-v4:0`.
- 868094c: Reduce instruction-unit extraction latency on dense agent-rule files by preferring one unit per normative span, capping `source_excerpt` length, disabling reasoning on that call, and deduping identical excerpts before promotion.
- 67e5ebf: Mitigate Bedrock repository-ingestion stalls by using non-streaming chat models for code-ingestion agents and hardening the ingest OpenWorkflow step retry (3 attempts with backoff). Conversation/MCP UI streaming is unchanged.

## 3.0.0

### Major Changes

- aff4d60: Breaking: remove `modelProvider.defaultModel` and separate embedding provider overrides (`embedding.baseUrl`, `embedding.apiKey`, `CtxPipeEmbeddingOverrides`). Configure openai-like and bedrock tiers through the required `models` prop (`models.fast` required).

  Migration:
  - Replace `defaultModel: "..."` with `models: { fast: "..." }`.
  - Remove `embedding.baseUrl` / `embedding.apiKey` — embeddings use the same provider URL and credentials as chat.

  Add Amazon Bedrock model provider support: `modelProvider.kind: "bedrock"` with per-tier model IDs and ECS task-role IAM (`bedrock:InvokeModel`, `bedrock:InvokeModelWithResponseStream`). The backend calls Bedrock Runtime natively with SigV4 credentials from the task role; no `MODEL_PROVIDER_API_KEY` secret is created.

### Minor Changes

- a4e252d: Allow users to manually trigger re-indexing and fix un-indexing bug

### Patch Changes

- 26701a1: Resolve idle transaction error
- aff4d60: Fix size profile database instance classes so Aurora PostgreSQL and Neptune use AWS-supported combinations (t4g.medium floor for small; r6g for larger Neptune tiers).
- aff4d60: Run the codesearch ECS container as uid/gid 1000 so Git repo-cache checkouts on EFS match the access point POSIX owner and avoid dubious-ownership reindex failures.

## 2.1.0

### Minor Changes

- 99dbb8b: Supports users' API key/tokens

### Patch Changes

- c5e635c: Use pg pool for codesearch to prevent dead connections
- 7e89d75: Fix GitHub repository setup so registering an installation no longer ingests all accessible repos before the user saves their selection. Select-mode saves now prune unselected connection-linked repositories and sync only chosen repos.
- 8607284: Fix org creation from the side nav so users redirect to the new org setup flow and the org switcher list refreshes immediately after create.
- 2be3a58: Fix the repositories page so select-specific GitHub setup only shows selected repositories as pending indexing, instead of every GitHub-accessible repository.
- 4247441: Ship the Elastic License 2.0 text with the package.
- 5bb0d02: Fix repo ingestion workflow
- 42653ff: Fix transaction behaviour for workflow
- 6650690: Resolve issues with ingestion timing out
- e60a18b: Fix selected GitHub repository saves so newly selected repos are linked and visible in the repositories list immediately while ingestion starts.
- 5890062: Fine-tune system prompt

## 2.0.0

### Major Changes

- 787a625: bugfix on unindexing repos

### Patch Changes

- 1945265: added CLI snippet to MCP slide during onboarding, and improved onboarding performance
- aeb90f3: Fix GitHub repository Manage flow so connected organisations open the correct GitHub App scope popup.
- 5e1ec05: Interaction fixes to the knowledge-graph UI

## 1.1.2

### Patch Changes

- 55c4840: Simplify backend Langfuse tracing: attach the LangChain callback handler once at graph boundaries and remove duplicate per-node callback wiring that caused Langfuse runMap warnings.

## 1.1.1

### Patch Changes

- 5b60917: Change how docker image tag is pinned

## 1.1.0

### Minor Changes

- Added size props to @ctxpipe/aws-cdk to allow customers configure AWS resources sizing.

## 1.0.2

### Patch Changes

- Ensure @ctxpipe/aws-cdk always get the latest changes for self-hosted customers.
- Add missing steps to Github Self-Host instructions.

## 1.0.1

### Patch Changes

- a797ca4: Remove serviceImageTag as allowing consumers to configure this can cause issue as provided image tag might not be compatible with the infra deployed by ctxpipe-ai/aws-cdk

## 1.0.0

### Major Changes

- 4574794: Customers can now self-host Ctxpipe on AWS with our @ctxpipe/aws-cdk
