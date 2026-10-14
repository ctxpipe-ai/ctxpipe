# MCP evaluation fixtures

P4-1 provides synthetic data for the MCPJam suite. It does not run an LLM evaluation.

The manifest defines two organizations and three Workspaces:

| Organization | Workspace | Data |
| --- | --- | --- |
| Harbor Labs | payments | Services, an idempotency decision, a replay runbook, a Linear ticket, and an incident |
| Harbor Labs | platform | A queue service and a capacity runbook |
| Meadow Works | payments | A different settlement service and a batch decision; no linked repository |

Both organizations use the `payments` slug. Harbor links `sindresorhus/is` from two Workspaces. These cases test organization isolation and repository deduplication. Meadow also supplies the no-repository case. All names and operational facts are synthetic. The public upstream repositories are real.

The manifest pins each upstream repository to a full commit SHA. Tag names explain the pins; the seed never resolves those tags at runtime. The fixture Git commits use a fixed author, message, and date. Each source file has the same last-commit time on each run.

## Prepare repositories

Run commands from the repository root. Install dependencies first.

```sh
pnpm --filter @ctxpipe/backend exec bun evals/mcp/run-seed.ts prepare /tmp/mcp-eval-repositories
```

The command creates three bare Git repositories and prints a JSON map of their URLs. It refuses an existing output directory. Keep these repositories while the evaluation uses them.

For local codesearch on the same host, use these file URLs. For Docker, mount the repository directory at the same absolute path in the backend and codesearch containers.

For a preview, publish the three bare repositories to dedicated test remotes that both services can read. Use `git push <test-remote> main` from each prepared bare repository. Put the three remote URLs in a JSON file with the keys `harbor-payments`, `harbor-platform`, and `meadow-payments`. The seed reads these remotes and refuses content that differs from the fixtures. It never pushes Git data itself.

## Seed a local or preview database

Use a migrated test database, a live FalkorDB, codesearch, and the normal embedding provider configuration. Run the command with the backend environment of the target. Use the `ctxpipe_app` database role. Do not run it against production.

```sh
pnpm --filter @ctxpipe/backend exec bun --env-file=.env.local evals/mcp/run-seed.ts seed local trial-1 USER_ID /tmp/mcp-eval-remotes.json
```

Replace `USER_ID` with an existing test user's id. For a preview, replace `local` with `preview` and run in that preview's backend environment. The command adds that user to both fixture organizations. It does not create credentials or print secrets. Connect the evaluation client as that user and consent to both organizations, or create a personal API key with both organizations.

The run name determines the organization slugs: `mcp-eval-trial-1-harbor` and `mcp-eval-trial-1-meadow`. Use a new run name for each seed. An existing run is refused before its data changes. A failed run can leave partial fixture data; use a fresh disposable database or a new run name after you correct the cause.

The seed reads committed Markdown through the production Git reader. It publishes units and chunks, embeds them through the configured provider, writes the live graph, and indexes the Workspace and pinned upstream repositories through codesearch. It reports success only after all stores are ready. The seed uses the domain functions directly and creates no OpenWorkflow backend.

## Proof

`src/mcp/eval-seed.integration.test.ts` uses real Git, Postgres as `ctxpipe_app`, and live FalkorDB. MSW replaces only the embedding and codesearch HTTP boundaries. It proves seed publication and organization isolation. It does not prove Zoekt or SCIP output. Native codesearch tests require `zoekt-webserver` and run in CI; the seed must also pass against real codesearch before MCPJam results are accepted.

## MCPJam eval suite (CTX-574)

`cases.ts` holds 22 coding-agent tasks. They run against the seeded fixture organizations. The suite uses `@mcpjam/sdk`: each case runs 3 times for each client model. A model must pass 0.9 of all iterations. A run also fails when a pass rate falls from `baseline.json` (aggregate: 0.05, one case: more than one lost iteration). A case checks tool choice, argument quality (the `excludeRepositories` rule, filters, search mode), result relevance (a tool result holds the expected ref), and task success (the answer holds the fixture facts). `check.ts` judges a run; `gate.ts` decides the exit code. Both are pure, and `src/mcp/eval-suite.test.ts` tests them without a model. That test also checks that each expected fact exists in the fixtures and that each argument fits the registered tool schemas.

Run it against a seeded target:

```sh
MCP_EVAL_URL=https://<backend>/mcp MCP_EVAL_API_KEY=<personal key with both orgs> MCP_EVAL_RUN=<seed run name> \
  ANTHROPIC_API_KEY=... OPENAI_API_KEY=... \
  pnpm --filter @ctxpipe/backend exec bun evals/mcp/run.ts --models <provider/model>,<provider/model> --out results.json
```

The tool list of the server picks the mode. With `ctx_advisor` alone, the run uses the advisor cases only and judges their answers. This records the advisor baseline before the cutover. With the seven read tools, the run uses all cases. Any other mix exits with code 2. Add `--update-baseline` to write the pass rates of the detected mode to `baseline.json`; the first run in each mode must do this, and the result goes in a commit. Without a stored baseline, only the 0.9 floor applies.

CI is `.github/workflows/mcp-evals.yaml`: nightly, on the label `mcp-evals`, and by hand. A labeled pull request runs against the preview URL from the PR Deploy comment. Other runs use the `MCP_EVAL_URL` and `MCP_EVAL_RUN` variables. The workflow also needs the secret `MCP_EVAL_API_KEY`, the provider keys, and the variable `MCP_EVAL_MODELS` (at least two models). A preview needs a seed first, because the seed reaches Postgres and FalkorDB that a CI runner cannot reach.
