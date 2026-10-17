# MCP evaluation fixtures

P4-1 provides synthetic data for the MCPJam suite. It does not run an LLM evaluation.

The manifest defines two organizations and three Workspaces:

| Organization | Workspace | Data |
| --- | --- | --- |
| Harbor Labs | payments | Services, an idempotency decision, a replay runbook, a Linear ticket (`linear/teams/HBR/issues/…`, with the front matter of a real mirror file), and an incident |
| Harbor Labs | platform | A queue service and a capacity runbook |
| Meadow Works | payments | A different settlement service and a batch decision; no linked repository |

Both organizations use the `payments` slug. Harbor links `sindresorhus/is` from two Workspaces. These cases test organization isolation and repository deduplication. Meadow also supplies the no-repository case. All names and operational facts are synthetic. The public upstream repositories are real.

The ticket and the incident link to each other and to the knowledge files, so the graph holds mirror edges. The ticket has kind `Issue` and the incident has kind `Incident`.

The manifest pins each upstream repository to a full commit SHA. Tag names explain the pins; the seed never resolves those tags at runtime. The fixture Git commits use a fixed author, message, and date. Each source file gets the last-commit time that the manifest names in `updatedAt` (spread from January to May 2026; a file without an entry uses `commitDate`). The times are the same on each run. Time filters and the recency signal have different values to rank.

The fixtures have no GitHub connection. The seed links the upstream repositories with a GitHub source row (`linked-repositories`) and uses each manifest SHA as the `ref` of its repository (ADR-050).

## Prepare repositories

Run commands from the repository root. Install dependencies first.

```sh
pnpm --filter @ctxpipe/backend exec bun evals/mcp/run-seed.ts prepare /tmp/mcp-eval-repositories
```

The command creates three bare Git repositories and prints a JSON map of their URLs. The `harbor-payments` repository also has a `next` branch with one more commit (the second projection, see below). It refuses an existing output directory. Keep these repositories while the evaluation uses them.

For a local run, use the file URLs on the same host. If you use Docker, mount the repository directory at the same absolute path in the backend and codesearch containers.

## Seed a local database

Use a migrated local test database, a live FalkorDB, codesearch, and the normal embedding provider configuration. Use the `ctxpipe_app` database role. Do not run it against production.

```sh
pnpm --filter @ctxpipe/backend exec bun --env-file=.env.local evals/mcp/run-seed.ts seed trial-1 USER_ID /tmp/mcp-eval-remotes.json
```

Replace `USER_ID` with an existing local test user's id. The command adds that user to both fixture organizations. It does not create credentials or print secrets. Connect the evaluation client as that user and consent to both organizations, or create a personal API key with both organizations.

The run name determines the organization slugs: `mcp-eval-trial-1-harbor` and `mcp-eval-trial-1-meadow`. Use a new run name for each seed. An existing run is refused before its data changes. A failed run can leave partial fixture data; use a fresh disposable database or a new run name after you correct the cause.

The seed reads committed Markdown through the production Git reader. It publishes units and chunks, embeds them through the configured provider, writes the live graph, and indexes the Workspace and pinned upstream repositories through codesearch. It reports success only after all stores are ready. The seed uses the domain functions directly and creates no OpenWorkflow backend.

## Move a Workspace to a second projection

After a seed, this command moves the Harbor `payments` Workspace to the commit on the `next` branch. It changes one file, adds one file, and publishes all stores again. A cursor made for the first projection is stale after it. P4-2 uses this to test a stale cursor.

```sh
pnpm --filter @ctxpipe/backend exec bun --env-file=.env.local evals/mcp/run-seed.ts advance trial-1 USER_ID /tmp/mcp-eval-remotes.json
```

The command prints the Workspace id and the new SHA. The first projection SHA is in the seed output. `advanceMcpEvalWorkspace` is the same step as a function.

## Proof

`src/mcp/eval-seed.integration.test.ts` uses real Git, Postgres as `ctxpipe_app`, and live FalkorDB. MSW replaces only the embedding and codesearch HTTP boundaries. It proves seed publication and organization isolation. The mock codesearch reports one language, so the seed reaches the SCIP phase on each index. The mock builds no shard, so no SCIP content is proven: P4-2 cases that read symbols, definitions, or references are unproven until the seed runs against real codesearch. The seed copies the domain calls of the hydrate and index workflows instead of running them, because the real hydrate workflow queues write jobs that a live worker would run against the fixture organizations; see the comment on `publishWorkspaceRevision`. Native codesearch tests require `zoekt-webserver` and run in CI; the seed must also pass against real codesearch before MCPJam results are accepted.

## MCPJam eval suite (CTX-574)

`cases.ts` holds 22 coding-agent tasks. They run against the seeded fixture organizations. The suite uses `@mcpjam/sdk`. Each case runs 3 times for each client model. A run needs at least two models.

A case checks four things:

- Tool choice: the agent calls the expected tools.
- Argument quality: the agent uses the `excludeRepositories` rule, filters, and the search mode correctly.
- Result relevance: a tool result holds the expected ref.
- Task success: the answer holds the fixture facts.

The gate divides passed iterations by requested iterations. An iteration that throws or times out is a failure. Each model must pass 0.9 of its iterations. When `baseline.json` holds a recorded run, the gate also fails on a fall from it. The aggregate may fall by 0.05. One case may lose one iteration.

`check.ts` judges a run, and `gate.ts` decides the exit code. Both are pure. `src/mcp/eval-suite.test.ts` tests them without a model. That test also checks that each expected fact exists in the fixtures. It also checks that each argument fits the registered tool schemas.

The `stale-cursor` case uses a real cursor. Before that case, `run.ts` calls `search_knowledge` and keeps the cursor. Then it runs `run-seed.ts advance`, so the Workspace moves to its second projection. The case runs last and expects the error `stale_cursor`. Thus each seed supports one run.

### CI

CI is `.github/workflows/mcp-evals.yaml`. It runs nightly, by hand, and on a pull request with the label `mcp-evals`. The job never uses a preview, because a preview database is a copy of production data. The job does these steps:

1. It starts Postgres and FalkorDB as service containers and applies the migrations.
2. It starts codesearch and the backend from the checked-out code.
3. It runs `run-seed.ts ci`. This command prepares the fixture repositories, creates a made-up user, and seeds the fixtures. It also creates a personal API key for the two fixture organizations only. It writes the key to a temporary file and does not print it.
4. It runs `run.ts` against `http://localhost:3000/mcp`.
5. It uploads the results with the pass rates of each model and case, and the logs.

The model provider keys are the only secrets. Only the steps that need them get them. The job runs in the GitHub environment `Preview`. It reads `MODEL_PROVIDER_API_KEY` for the backend, and `ANTHROPIC_API_KEY` and `OPENAI_API_KEY` for the client models. These are spend-capped keys for CI. The production values stay in the `Production` environment. `run.ts` reads each client key as `<PROVIDER>_API_KEY` and stops when a model has no key. The variable `MCP_EVAL_MODELS` names the client models, at least two.

A pull request that changes `apps/backend/src/mcp` does not run the suite, because each run calls paid models. `.github/workflows/mcp-evals-reminder.yaml` adds a comment that asks for the label.

### Record the baseline (one time)

Until `baseline.json` holds a run, it is `null`, and only the 0.9 floor applies. The job summary says so. To record the baseline, do these steps:

1. Start the workflow by hand with `update_baseline` set.
2. Download `baseline.json` from the `mcp-eval-results` artifact.
3. Commit it as `apps/backend/evals/mcp/baseline.json`.

### Run on a local stack

Use a fresh migrated database, live FalkorDB, codesearch, and the backend environment. Run commands from `apps/backend`.

```sh
bun --env-file=.env.local evals/mcp/run-seed.ts ci local1 /tmp/mcp-eval-fixtures /tmp/mcp-eval-seed.json
ANTHROPIC_API_KEY=... OPENAI_API_KEY=... bun --env-file=.env.local evals/mcp/run.ts \
  --url http://localhost:3000/mcp --seed /tmp/mcp-eval-seed.json \
  --models <provider/model>,<provider/model> --out results.json
```

The server must offer exactly the seven read tools. Any other tool set exits with code 2.
