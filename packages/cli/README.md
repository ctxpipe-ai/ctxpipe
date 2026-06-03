# ctx| CLI

Universal ctx| CLI for initializing repositories and agent integrations. Install and run with **`npx ctxpipe`** (no global install required).

## Human setup

```bash
npx ctxpipe init
```

This opens an interactive wizard with repo/global setup scope selection, detected agent defaults, multi-select client setup, and a final change summary before anything is written.

If no organization is supplied, the wizard signs you in with a browser/device-code flow, loads your ctx| organizations, and lets you choose one. MCP clients still perform their own OAuth later when they first use ctx|.

**Setup credentials:** the CLI stores setup-auth tokens in the **OS keychain** when available (`@napi-rs/keyring`). If the keychain cannot be used (headless Linux, unsupported environment), it falls back to a file under `~/.config/ctxpipe/` and prints a one-time notice to stderr.

Auth helpers:

```bash
npx ctxpipe auth login
npx ctxpipe auth whoami
npx ctxpipe auth logout
```

Use **`npx ctxpipe <command> --help`** for full flags (for example `npx ctxpipe init --help` lists `--base-url`, `--scope`, `--agents`, `--dry-run`, `--json`, `--non-interactive`, and `--no-mcp`).

## Agent and CI setup

```bash
npx ctxpipe init --org acme --agents codex,claude --scope repo --non-interactive
npx ctxpipe mcp add --org acme --client cursor --scope user --non-interactive
npx ctxpipe memory init --agents cursor --non-interactive
npx ctxpipe doctor --json
```

### Local memory only (no remote ctxpipe MCP)

```bash
npx ctxpipe memory init
npx ctxpipe memory init --agents cursor --non-interactive
```

Interactive `memory init` offers optional sign-in or **Continue without login** for local-only save/search. Non-interactive mode defaults `--scope` to `repo` and does not require `--org`.

Full init with memory add-on (remote MCP + memory): `npx ctxpipe init --org acme --agents cursor --memory --non-interactive`.

This package is in alpha while the interactive setup flow is being built.

## Contributing / repo checkout

From this monorepo, after `pnpm install` and `pnpm --filter ctxpipe build`, you can run `node packages/cli/bin/ctxpipe.js …` or `pnpm exec ctxpipe …` from the repo root if linked.

### Testing local memory (CLI / MCP)

Mirrors [AgentMemory](https://github.com/rohitg00/agentmemory)’s split: fast unit tests by default, integration on demand.

```bash
pnpm --filter ctxpipe build
pnpm --filter ctxpipe test                    # fast; excludes test/memory/integration-*.test.ts
pnpm --filter ctxpipe test:memory:integration # real pinned @agentmemory/agentmemory (network on first npx)
pnpm --filter ctxpipe test:all                # fast, then integration (sequential)
```

CI runs `test` and `test:memory:integration` on every PR ([`.github/workflows/cli-test.yaml`](../../.github/workflows/cli-test.yaml)).

When spawning AgentMemory (default integration path), **port 3111** must be free on loopback — the pinned package’s iii-http worker binds there even though ctxpipe allocates other ports per repo. If 3111 is taken locally, free it or set `AGENTMEMORY_URL` to an existing server.

Optional — use an already-running AgentMemory server (upstream-style):

```bash
export AGENTMEMORY_URL=http://127.0.0.1:3111
export AGENTMEMORY_SECRET=your-local-secret
pnpm --filter ctxpipe test:memory:integration
```
