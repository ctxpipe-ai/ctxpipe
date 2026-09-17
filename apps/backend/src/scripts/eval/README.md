# Graph overhaul evals (ADR-033)

Three rungs of confidence, cheapest first. Rung 1 is the test suite (unit, renderer
round-trips, the golden fixture snapshot in `graphs/codeIngestionGraph/graphGolden.test.ts`,
and `nodes/evidenceLifecycle.integration.test.ts` when `DATABASE_URL` is set).

## Running the database-backed tests locally

`nodes/evidenceLifecycle.integration.test.ts` skips unless `DATABASE_URL` is set. It covers
evidence dedup across commits, retraction on file deletion, purge on repository deletion, the
legacy-unit cleanup, and the quality SQL. Start the local Postgres (Compose / colima), migrate,
then:

```bash
cd apps/backend
DATABASE_URL=postgresql://… pnpm exec vitest run src/graphs/codeIngestionGraph/nodes/evidenceLifecycle.integration.test.ts
```

The harness itself is unit-tested without network in `answerEvalCore.test.ts` (body parsing,
grading, report, and the MCP handshake with an injected `fetch`).

## Rung 2 — structural before/after on real data

Railway `pr-N` preview databases are forked from production, so the fork *before* any
action is the baseline.

```bash
# on the preview (or against a fork), before anything runs
bun run src/scripts/graphQualityReport.ts --org-id <org> --out before.json

# re-index everything (or pass --repository-id <id>) with the environment's variables:
#   railway run --environment <env> --service backend -- bun run src/scripts/reindexRepositories.ts --org-id <org> --all
# run the cleanup as an org admin from the app's browser session (the maintenance route
# requires an admin session, not an API key):
#   fetch("/<org-slug>/api/v1/knowledge-graph/maintenance/retract-connector-instructions", { method: "POST" })
# then re-ingest the chosen repositories (Repositories → Retry indexing) and, if wanted,
# enable the PR mirror backfill; wait for ingestion to finish.
# Quality can be read with a session or an org API key:
curl -H "x-api-key: $KEY" https://<preview>/<org-slug>/api/v1/knowledge-graph/quality

bun run src/scripts/graphQualityReport.ts --org-id <org> --out after.json
bun run src/scripts/graphQualityReport.ts --compare before.json after.json
```

Ship gates: join density up, orphan rate down, evidence rows per claim ≈ 1, connector-derived
instruction units = 0, retired predicates absent from the predicate table.

Preview caveats (see `.ai/memory/lessons-learned.md`): preview workers sleep within minutes,
so watch for a new worker deploy after enqueueing; backfills need GitHub App credentials on
the preview.

## Rung 3 — answer eval

1. Copy `questions.template.jsonl`, replace the placeholders with real TruRec names, and add
   twenty to thirty questions from real `ctx_advisor` conversations (conversation history lives
   in the LangGraph checkpointer, so curate by hand). Keep the `code-regression` rows: they
   guard against the planner and traversal changes making ordinary code answers worse.
2. Copy `targets.example.json` and set the MCP URLs and API-key env names for production and
   the preview.
3. Run:

```bash
CTXPIPE_API_KEY_PROD=… CTXPIPE_API_KEY_PREVIEW=… \
bun run src/scripts/eval/answerEval.ts \
  --questions questions.jsonl --targets targets.json --out answer-eval.md --judge
```

The report scores citations, resolvable citations, expected graph kinds reached, and with
`--judge` (uses the org model provider from `.env.local`) correctness, grounding, and whether
any answer presents a ticket as a standard. Spot-check a sample of judged rows by hand.
