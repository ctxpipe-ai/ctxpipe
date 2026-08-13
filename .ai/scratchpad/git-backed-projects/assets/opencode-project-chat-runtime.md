# OpenCode as an in-product project chat runtime

Research date: 2026-08-13. OpenCode source was inspected at
[`864889ab9f9e921c240930b1dcd2bc0d2352c555`](https://github.com/anomalyco/opencode/tree/864889ab9f9e921c240930b1dcd2bc0d2352c555)
(`opencode` package version `1.18.18`).

## Executive summary (facts)

- **Yes, OpenCode can be run as the agent process inside a container and pointed at an already-created project worktree.** It exposes a non-interactive CLI, a headless HTTP/OpenAPI server, a JS/TS SDK that can launch or connect to that server, server-sent events, asynchronous prompts, and an ACP stdin/stdout server. The caller can select the working directory with CLI `--dir`, the SDK `directory` option, or the HTTP directory routing field. [CLI](https://opencode.ai/docs/cli/#run) · [server](https://opencode.ai/docs/server/) · [SDK](https://opencode.ai/docs/sdk/)
- OpenCode understands linked Git worktrees: its repository discovery asks Git for the top-level worktree, per-worktree Git directory, and common Git directory. Supplying the linked-worktree path therefore scopes ordinary file edits to that worktree, not the main checkout's working files. It still needs access to the shared Git repository metadata referenced by the worktree's `.git` file. [OpenCode Git discovery](https://github.com/anomalyco/opencode/blob/864889ab9f9e921c240930b1dcd2bc0d2352c555/packages/core/src/git.ts#L184-L203) · [Git repository layout](https://git-scm.com/docs/gitrepository-layout)
- OpenCode's permissions are **application-level approvals/denials, not a filesystem or network sandbox**. The build agent and most permissions are permissive by default; after permission evaluation, the shell tool starts an ordinary host shell in the selected directory and inherits the OpenCode process environment. Container/filesystem mounts, process privileges, resource limits, and network egress isolation must come from the surrounding runtime. [permissions](https://opencode.ai/docs/permissions/#defaults) · [shell implementation](https://github.com/anomalyco/opencode/blob/864889ab9f9e921c240930b1dcd2bc0d2352c555/packages/opencode/src/tool/shell.ts#L293-L309) · [inherited environment](https://github.com/anomalyco/opencode/blob/864889ab9f9e921c240930b1dcd2bc0d2352c555/packages/opencode/src/tool/shell.ts#L416-L425)
- Conversation state is OpenCode-owned local state, not Git history. Current source stores projects, sessions, messages, parts, and related state in a SQLite database under OpenCode's XDG data directory. Undo/diff snapshots use a separate internal Git directory under that data directory. The CLI can export a session as JSON. [database path](https://github.com/anomalyco/opencode/blob/864889ab9f9e921c240930b1dcd2bc0d2352c555/packages/core/src/database/database.ts#L43-L57) · [session rows](https://github.com/anomalyco/opencode/blob/864889ab9f9e921c240930b1dcd2bc0d2352c555/packages/opencode/src/session/session.ts#L57-L158) · [snapshot store](https://github.com/anomalyco/opencode/blob/864889ab9f9e921c240930b1dcd2bc0d2352c555/packages/opencode/src/snapshot/index.ts#L66-L76) · [export command](https://opencode.ai/docs/cli/#export)
- OpenCode owns its model/provider runtime. Models use `provider/model` identifiers and can be selected globally, per agent, per prompt, or by CLI flag. Providers can use environment credentials, OpenCode's credential store, custom base URLs, or custom AI SDK providers. This is separate from ctxpipe's LangChain-based `getModel()` factory. [models](https://opencode.ai/docs/models/) · [providers](https://opencode.ai/docs/providers/) · [ctxpipe model factory](../../../../apps/backend/src/retrieval/services/modelProvider.ts)
- The source is MIT-licensed. The licence permits use, modification, distribution, sublicensing, and sale, with preservation of the copyright and licence notice in copies or substantial portions and with no warranty. OpenCode's separately advertised Enterprise central-config/SSO assistance is per-seat; the official page does not turn that offering into a restriction on the MIT source. Provider terms and transitive dependency licences are separate. [MIT licence](https://github.com/anomalyco/opencode/blob/864889ab9f9e921c240930b1dcd2bc0d2352c555/LICENSE) · [Enterprise offering](https://opencode.ai/docs/enterprise/)
- Normal project chat does not require a commit or push. It edits the working tree and maintains its own snapshots. However, the build agent can run arbitrary shell commands by default, including Git commands, so commit and push are possible unless denied. OpenCode's dedicated GitHub automation is a separate path that explicitly commits and pushes. [tools](https://opencode.ai/docs/tools/#bash) · [Git permission example](https://opencode.ai/docs/permissions/#agents) · [GitHub automation source](https://github.com/anomalyco/opencode/blob/864889ab9f9e921c240930b1dcd2bc0d2352c555/packages/opencode/src/cli/cmd/github.handler.ts#L1086-L1117)

## Findings with citations

### Current ctxpipe integration

ctxpipe currently treats OpenCode as an external client:

- the CLI recognises `opencode` as a client and maps it to the external `opencode` executable ([client constants](../../../../packages/cli/src/constants.ts));
- onboarding writes a remote `ctxpipe` MCP entry into repository or user `opencode.json` ([operation builder](../../../../packages/cli/src/mcp/mcp-operations.ts));
- the UI presents OpenCode as an MCP configuration target ([onboarding wizard](../../../../apps/ui/src/components/onboarding/McpConfigPrWizard.tsx)).

There is no `opencode` or `@opencode-ai/*` package dependency in workspace `package.json` files and no OpenCode service in [`docker-compose.yml`](../../../../docker-compose.yml). In other words, the current repository configuration path does not start a server-side OpenCode runtime.

### Programmatic drive

OpenCode has four programmatic surfaces:

1. **One-shot CLI:** `opencode run [message..]` is non-interactive, supports JSON event output, session continuation/forking, model and agent selection, file attachments, `--dir`, and attachment to an existing server. [CLI `run`](https://opencode.ai/docs/cli/#run)
2. **Headless HTTP server:** `opencode serve` exposes an OpenAPI 3.1 service. Its APIs cover session creation/listing/deletion, synchronous and asynchronous prompts, message history, diffs, abort, revert, permissions, files, config/providers, MCP, and SSE events. [server API](https://opencode.ai/docs/server/)
3. **JS/TS SDK:** `createOpencode()` starts an OpenCode subprocess plus client; `createOpencodeClient()` connects to an existing server. The SDK exposes typed session operations and event subscription. [SDK](https://opencode.ai/docs/sdk/) · [subprocess launcher](https://github.com/anomalyco/opencode/blob/864889ab9f9e921c240930b1dcd2bc0d2352c555/packages/sdk/js/src/server.ts#L22-L100)
4. **ACP:** `opencode acp` exposes an Agent Client Protocol server over newline-delimited JSON on stdin/stdout and accepts `--cwd`. [CLI `acp`](https://opencode.ai/docs/cli/#acp)

The HTTP server defaults to `127.0.0.1:4096`. Setting `OPENCODE_SERVER_PASSWORD` enables HTTP Basic authentication; without it, the server is unsecured. CORS origins are explicit CLI options. [server authentication](https://opencode.ai/docs/server/#authentication) · [serve warning](https://github.com/anomalyco/opencode/blob/864889ab9f9e921c240930b1dcd2bc0d2352c555/packages/opencode/src/cli/cmd/serve.ts#L13-L20)

### Existing worktree scoping

`opencode run --dir /path/to/worktree ...` selects an existing directory. For the SDK/server path, `createOpencodeClient({ directory })` adds `x-opencode-directory`; GET/HEAD requests are rewritten to a `directory` query parameter. The server resolves a request from its session directory, query parameter, header, or finally `process.cwd()`. [SDK directory routing](https://github.com/anomalyco/opencode/blob/864889ab9f9e921c240930b1dcd2bc0d2352c555/packages/sdk/js/src/client.ts#L17-L56) · [server routing](https://github.com/anomalyco/opencode/blob/864889ab9f9e921c240930b1dcd2bc0d2352c555/packages/opencode/src/server/routes/instance/httpapi/middleware/workspace-routing.ts#L86-L88)

OpenCode calls `git rev-parse --show-toplevel`, `--git-dir`, and `--git-common-dir`, retaining all three paths. It records the discovered top-level path as the worktree and uses the directory for session scoping. [Git discovery](https://github.com/anomalyco/opencode/blob/864889ab9f9e921c240930b1dcd2bc0d2352c555/packages/core/src/git.ts#L184-L203) · [session directory field](https://github.com/anomalyco/opencode/blob/864889ab9f9e921c240930b1dcd2bc0d2352c555/packages/opencode/src/session/session.ts#L78-L117)

Two qualifications follow directly from the source and Git layout:

- A linked worktree's `.git` is normally a text pointer to administrative data in the common repository. Git documents that a repository using `commondir` is incomplete without the referenced common repository. Mounting only visible worktree files while omitting the referenced Git directories will therefore break Git-backed OpenCode behaviour. [Git layout](https://git-scm.com/docs/gitrepository-layout)
- OpenCode writes a small project ID cache named `opencode` in the Git common directory. Its snapshot history is separate, under OpenCode's data directory, but normal Git commands run by the agent can mutate shared objects and refs. These are shared-repository metadata effects even though another worktree's checked-out files are not directly edited. [project ID cache](https://github.com/anomalyco/opencode/blob/864889ab9f9e921c240930b1dcd2bc0d2352c555/packages/core/src/project.ts#L110-L126) · [snapshot path](https://github.com/anomalyco/opencode/blob/864889ab9f9e921c240930b1dcd2bc0d2352c555/packages/opencode/src/snapshot/index.ts#L66-L76)

OpenCode also has experimental APIs that can create, list, reset, and remove its own worktrees. Creation places them under OpenCode's data directory and creates `opencode/<name>` branches. That feature is not required to operate on a worktree supplied by ctxpipe. [worktree implementation](https://github.com/anomalyco/opencode/blob/864889ab9f9e921c240930b1dcd2bc0d2352c555/packages/opencode/src/worktree/index.ts#L174-L229)

### Filesystem and network isolation

OpenCode permissions decide whether a tool call is allowed, denied, or paused for approval. Most permissions default to `allow`; only `external_directory` and doom-loop detection default to `ask`, and `.env` reads have a default deny rule. [permission defaults](https://opencode.ai/docs/permissions/#defaults)

For path-aware tools, `external_directory` checks whether a target is under the selected directory or repository worktree and asks for approval otherwise. [boundary check](https://github.com/anomalyco/opencode/blob/864889ab9f9e921c240930b1dcd2bc0d2352c555/packages/opencode/src/project/instance-context.ts#L13-L24) · [external-directory tool guard](https://github.com/anomalyco/opencode/blob/864889ab9f9e921c240930b1dcd2bc0d2352c555/packages/opencode/src/tool/external-directory.ts#L15-L44)

This does not create kernel isolation:

- the bash tool parses commands for permission patterns and selected path-bearing commands, then launches the requested shell command as a child process with the selected `cwd`; [scan and approval](https://github.com/anomalyco/opencode/blob/864889ab9f9e921c240930b1dcd2bc0d2352c555/packages/opencode/src/tool/shell.ts#L378-L414) · [execution](https://github.com/anomalyco/opencode/blob/864889ab9f9e921c240930b1dcd2bc0d2352c555/packages/opencode/src/tool/shell.ts#L481-L559)
- the shell environment starts with all of `process.env`; [environment construction](https://github.com/anomalyco/opencode/blob/864889ab9f9e921c240930b1dcd2bc0d2352c555/packages/opencode/src/tool/shell.ts#L416-L425)
- built-in web fetch/search tools and arbitrary shell commands can make outbound requests, and the documented network controls are proxy and custom-CA settings rather than an egress-deny sandbox. [tools](https://opencode.ai/docs/tools/) · [network configuration](https://opencode.ai/docs/network/)

Therefore OpenCode supplies policy prompts and permission gates, while a surrounding container/sandbox must supply the actual mount boundary, user/UID, capabilities, process/resource limits, secret exposure policy, and network policy.

### Session, transcript, and change persistence

OpenCode uses XDG directories for data, cache, config, and state; on a typical Linux container the data directory resolves under `~/.local/share/opencode`. [global paths](https://github.com/anomalyco/opencode/blob/864889ab9f9e921c240930b1dcd2bc0d2352c555/packages/core/src/global.ts#L10-L29)

The current database implementation opens `opencode.db` in that data directory, uses SQLite WAL mode, and runs schema migrations. Session records include project, worktree directory, model, tokens, summary, sharing, permissions, and timestamps; messages and parts are related database records. [database](https://github.com/anomalyco/opencode/blob/864889ab9f9e921c240930b1dcd2bc0d2352c555/packages/core/src/database/database.ts#L22-L57) · [session persistence](https://github.com/anomalyco/opencode/blob/864889ab9f9e921c240930b1dcd2bc0d2352c555/packages/opencode/src/session/session.ts#L57-L158)

File edits remain in the supplied worktree. Undo/diff support stores snapshots in a separate internal Git directory at `<OpenCode data>/snapshot/<project-id>/<worktree-hash>` and addresses that store with `--git-dir`/`--work-tree`; these snapshots are not commits in the project's normal branch history. [snapshot implementation](https://github.com/anomalyco/opencode/blob/864889ab9f9e921c240930b1dcd2bc0d2352c555/packages/opencode/src/snapshot/index.ts#L66-L84)

Consequences:

- preserving only the project worktree preserves edits but not the OpenCode transcript/session database;
- preserving only OpenCode's data directory preserves session records and snapshots but not necessarily the edited checkout;
- an ephemeral container loses OpenCode history unless its data directory is persisted or sessions are exported;
- `opencode export [sessionID]` emits JSON, and `opencode import` restores from JSON or a share URL. [export/import](https://opencode.ai/docs/cli/#export)

Sharing is separate from local persistence. Manual sharing is enabled by default but does not upload until invoked; `share: "auto"` uploads every new conversation, while `share: "disabled"` blocks the feature. A shared session sends full conversation history, responses, and metadata to OpenCode's sharing service and remains there until unshared. [sharing](https://opencode.ai/docs/share/)

### Model and provider configuration

OpenCode supports built-in and custom providers through the Vercel AI SDK and Models.dev. A model is named `provider_id/model_id`; selection priority starts with the CLI `--model` flag, then config, last-used model, and an internal fallback. Global model options, provider-specific options, variants, and per-agent model overrides are supported. [models](https://opencode.ai/docs/models/) · [agent model overrides](https://opencode.ai/docs/agents/#model)

Provider configuration supports provider allow/deny lists, API keys, custom `baseURL`, custom provider npm packages, and explicit model definitions. Interactive provider credentials are stored in `~/.local/share/opencode/auth.json`; environment variables and project `.env` values are also loaded. [providers](https://opencode.ai/docs/providers/) · [credential storage](https://opencode.ai/docs/cli/#auth)

The SDK can pass inline config when it launches the OpenCode server, and individual prompt requests can include `{ providerID, modelID }`. [SDK config and prompt](https://opencode.ai/docs/sdk/#config)

ctxpipe's current backend model path instead constructs LangChain chat models from `MODEL_PROVIDER`, tiered `MODEL_*_NAME` values, and provider adapters. No source-level bridge from that factory into OpenCode exists today. [ctxpipe `getModel()`](../../../../apps/backend/src/retrieval/services/modelProvider.ts)

### Licence and hosted-operation facts

The repository root and package metadata identify OpenCode as MIT. The licence expressly allows use, copying, modification, publishing, distribution, sublicensing, and sale. It requires the copyright and permission notice in copies or substantial portions and disclaims warranty and liability. It has no source-disclosure, copyleft, field-of-use, seat, or hosted-service clause. [licence text](https://github.com/anomalyco/opencode/blob/864889ab9f9e921c240930b1dcd2bc0d2352c555/LICENSE) · [package metadata](https://github.com/anomalyco/opencode/blob/864889ab9f9e921c240930b1dcd2bc0d2352c555/packages/opencode/package.json#L1-L7)

OpenCode separately markets an Enterprise offering for central configuration, SSO integration, internal AI-gateway restriction, and assistance, using per-seat pricing. Those hosted services/features may have commercial terms, but the official MIT licence remains the licence on the inspected source. [Enterprise](https://opencode.ai/docs/enterprise/)

The MIT finding covers OpenCode itself, not a complete legal audit of its transitive dependencies, optional plugins, model providers, Models.dev data, Exa search service, or any provider's API/output terms.

### Commit and push behaviour

The ordinary chat/session APIs return messages, diffs, status, and snapshots; they do not require a commit or push to finish a turn. Edits are ordinary working-tree changes. [session APIs](https://opencode.ai/docs/server/#sessions)

The default build agent nevertheless has full tool access, and bash can execute any command. OpenCode's own permission documentation demonstrates rules that allow `git *` while separately denying `git commit *` and `git push *`; this would be unnecessary if those commands were intrinsically unavailable. [build agent](https://opencode.ai/docs/agents/#use-build) · [Git permission rules](https://opencode.ai/docs/permissions/#agents)

Thus normal chat **can** leave only uncommitted edits, but it is not guaranteed to do so under permissive defaults. Commit/push behaviour is controllable through the bash permission policy and prompt. The `opencode github run` workflow is distinct: its source stages, commits, creates/switches branches, and pushes as part of GitHub automation. [GitHub handler](https://github.com/anomalyco/opencode/blob/864889ab9f9e921c240930b1dcd2bc0d2352c555/packages/opencode/src/cli/cmd/github.handler.ts#L1086-L1117)

## Constraints

1. **External containment is required.** OpenCode permissions are not a replacement for a container or stronger sandbox.
2. **A linked worktree is not self-contained.** Its Git administrative and common directories must be reachable for repository discovery, snapshots, status, and any Git operations. Those shared paths are also a mutation surface.
3. **Directory routing is caller-controlled.** A headless server can accept a directory through request metadata and falls back to its process working directory. The container's mount boundary must remain the authoritative scope.
4. **Server authentication is one optional Basic-auth credential.** The inspected server surface does not itself provide ctxpipe organisation/user tenancy. Without the password environment variable it is unauthenticated.
5. **Runtime state is shared within one OpenCode data directory.** The SQLite database, credentials, model recency, logs, snapshots, and provider configuration are process/container-level local state, while sessions carry project/directory fields.
6. **Persistence has two independent parts.** Worktree changes and OpenCode data must be considered separately; Git commits alone do not preserve transcripts.
7. **Secrets reach tools unless filtered externally.** The shell inherits the OpenCode process environment. Provider credentials placed there are visible to shell commands running with the same process privileges.
8. **Network use is intrinsic to configured providers and optional tools.** OpenCode offers proxies, provider allowlists, and tool permissions, but the surrounding runtime must enforce hard egress restrictions.
9. **Sharing must be treated separately from local chat.** Manual sharing is available by default; invoking it sends session data to OpenCode's service. The official configuration can disable it.
10. **Git lifecycle is not inherently edit-only.** Standard chat has no required commit/push step, but permissive bash access permits both. The dedicated GitHub automation explicitly performs them.
11. **Source/version behaviour can change.** HTTP routing, storage, workspaces, and worktree APIs are active development areas; the findings above are pinned to the inspected SHA and current official docs.

## What this does NOT decide

This research does not choose:

- one OpenCode process per chat, project, worktree, tenant, or host;
- whether ctxpipe should use HTTP, the SDK-managed subprocess, one-shot CLI, or ACP;
- who creates, mounts, resets, commits, pushes, or destroys worktrees;
- whether session transcripts live only in OpenCode SQLite, are copied into ctxpipe storage, exported, or represented in Git;
- which container/sandbox technology, resource limits, filesystem mounts, or egress policy to use;
- whether OpenCode receives provider credentials directly or talks through a ctxpipe/internal model gateway;
- how ctxpipe authentication and tenancy map onto an OpenCode server;
- whether commit/push commands are denied, approval-gated, or allowed;
- whether OpenCode's own experimental worktree management or sharing features are enabled;
- whether the product should adopt OpenCode at all.
