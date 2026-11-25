# ADR-069: The knowledge plane is proven with public-corpus evals and turned on for one org at a time

**Status:** Accepted (the CTO, 2026-11-19; nothing is built yet; amended 2026-11-22, CTX-1499: hill-climb by generations) | **Date:** 2026-11-19 | **Tags:** knowledge, evals, dataset, rollout, feature-flags, better-auth, privacy

## Context

[ADR-066](ADR-066-knowledge-content-in-clickhouse.md), [ADR-067](ADR-067-knowledge-projection-applies-git-diff.md) and [ADR-068](ADR-068-knowledge-retrieval-jev-layers.md) replace the knowledge plane. The approach is:

1. Build a proof of concept (PoC) with the best guesses of those ADRs.
2. Build a good dataset.
3. Improve the quality in small measured steps.

The dataset must cover three shapes of customer: one large monorepo, an org with many repositories, and an org that uses GitHub Issues heavily. The repository is public, so the dataset must hold no customer data. The repository ingest runs model agents, so it is the expensive part, and it must run only once for each dataset version.

## Decision

1. **The PoC runs next to the current stack.**
   - It has the thinnest end-to-end path:
     - ClickHouse in Compose;
     - `KnowledgeStore`;
     - a full hydrate first, then the diff apply;
     - the search, the Jev layers and the disagreement step;
     - the same MCP tools as today.
   - The current Postgres and FalkorDB pipeline is the baseline arm of every eval.
   - The eval has exactly two arms: the current stack (the baseline) and the new plane. There is no arm without Jev, because Jev is a load-bearing part of the plane (the CTO, 2026-11-19).
   - The improvement loop tunes Jev (questions, thresholds, budgets). A later comparison of Jev with another decision model swaps that model in behind the same judge interface, as a separate arm of the plane. It is not part of the first evals.
2. **Public corpora.** Each source becomes one Workspace:

   | Source | Gives |
   | -- | -- |
   | Backstage (`backstage/*`) | A large TypeScript monorepo, which we build a context repo from. ADRs, RFCs as issues, and docs with diagrams. |
   | Kubernetes (`kubernetes/*`, `kubernetes-sigs/*`) | Many repositories and very many issues. Enhancement proposals with a status, which are natural disagreements. Website diagrams. Also the scale corpus. |
   | Rust (`rust-lang/*`) | A large repository, many repositories and very many issues. RFCs that are postponed or replaced. A different domain. |
   | ctxpipe (this repository) | A small pnpm monorepo, and ADRs with superseded entries. We know the true answers best. |

   - We build each Workspace through our real ingest path: the repository ingest and the GitHub issue mirror converter (`services/github/issue-mirror`). We cannot install our GitHub App on another org. Thus, a fixture importer reads the public API and calls the same converter.
   - Each source is a fixed snapshot: commit SHAs and an issue cut-off date. We take a slice of each source, except the Kubernetes scale corpus.
   - Before we publish the dataset, we check each license and remove personal data that the evals do not need, for example commit email addresses.
3. **Ingest once, then freeze.**
   - The ingest runs once for each dataset version. Its output, the context repo of each source at a fixed SHA, is the dataset. An eval run repeats only the hydrate and the retrieval.
   - To control the cost:
     1. Ingest one small slice first and measure the cost for each repository and each file.
     2. Choose slices that fit an agreed budget.
     3. Set a spend cap.
   - The issue mirror converter makes no model calls.
   - Embeddings are cached by chunk hash and model. Models are compared on the quality slices only.
   - The scale corpus (about 1 million chunks) repeats real chunks with made-up vectors. Latency does not depend on what the vectors mean, so it needs no ingest and no embedding calls.
4. **The ingest bootstrap is out of scope for these evals.**
   - The ingest agents use retrieval over the context repo, so a good ingest needs a context repo first.
   - The evals break this cycle: the current production stack makes the frozen ingest output, and both arms hydrate the same output. If the dataset depended on the system under test, the comparison would not be fair.
   - The product ingest bootstraps in passes:
     1. a deterministic pass (structure, READMEs, ADR files, mirrored issues);
     2. a hydrate;
     3. the model pass;
     4. later commits and the maintenance job fill the gaps.
   - Ingest quality is a separate eval loop.
5. **Questions.**
   - About 150 in version 0, in these categories:
     - one-document lookup;
     - multi-hop;
     - across sources;
     - time;
     - disagreement (current, superseded, partial, scoped);
     - needs an image;
     - no answer, where the correct result is "nothing found".
   - The gold labels are the relevant document ids, the expected positions and their status, and the key facts of the answer.
   - A model drafts the questions and labels. A judge panel of three model families labels them by majority, as in ADR-063. The CTO checks a sample.
   - There is a dev set to tune with, and a hold-out set for the keep-or-revert decision only. Jev is never a judge.
6. **Metrics, at four levels.**
   - **Component** (the main loop):
     - search recall@50;
     - traversal recall;
     - the accuracy of Jev's p(answers);
     - the accuracy of the pair labels and the position status;
     - image recall.
   - **Retrieval:** recall@5, nDCG@10, a correct "no answer", and valid "why" paths.
   - **Agent tasks:** the with-and-without harness of [CTX-1117](https://linear.app/ctxpipe/issue/CTX-1117), and the MCP eval gate.
   - **Operations** (guards):
     - p50 and p95 with a hot and a cold cache;
     - the ClickHouse rows and bytes read;
     - the Jev calls and cost for each retrieval;
     - the ingest cost and time for each document.
7. **The improvement loop.**
   - The evals run on the host through `factory eval knowledge:…`, with a spend cap, as in ADR-063.
   - Each run writes a report for each question against the last kept baseline.
   - A run changes one setting. The change stays only if the hold-out set improves and no guard metric gets worse.
   - A run keeps the raw Jev answers and embeddings, so that a new threshold is scored again with no new calls.
8. **Correctness tests, not evals:**
   - a diff applied one commit at a time equals a full rebuild;
   - a crash and retry gives the same result;
   - the status lifecycle works;
   - each org isolation wall works on its own;
   - load, while a hydrate runs at the same time.
9. **Rollout for one org at a time.**
   - **The flag.** A flag for each org has three values:
     - `off`: the old stack;
     - `shadow`: the old stack answers, and the new path runs and logs only its metrics;
     - `on`: ClickHouse answers.

     The CTO asked for a flag mechanism that later features can also use. The first choice was the `better-auth-feature-flags` plugin, with four conditions. It failed three of them ([CTX-1394](https://linear.app/ctxpipe/issue/CTX-1394)):
     - it does not load with `better-auth` 1.6;
     - its storage does not reach a table, and its evaluate endpoint takes the org id from the request body with no session;
     - its last release was 14 months ago, with one maintainer.

     Thus the flag is one Postgres table of our own: `org_features (organization_id, feature, value, updated_at)`. Its primary key is `(organization_id, feature)`, and it is under the org RLS policy. `knowledge_plane` is its only feature now, with the closed values `off`, `shadow` and `on`, and no row means `off`. One reader serves the backend and the worker, and there is no HTTP route. A later feature adds a value to the closed set of features. The hosted config sets a value with `apps/backend/src/db/set-org-feature.ts <org id> <feature> <value>` ([CTX-1424](https://linear.app/ctxpipe/issue/CTX-1424)). The hosted stack runs it as a one-off task for each entry of its private config (factory `hosted:orgFeatures`), so the org id stays out of this repository, and the reviewed config change is the audit trail. Each run logs `org_features.set` with the old and the new value. A rollback is a config change and a hosted release (about 20 minutes). That is sufficient for `shadow`, because the old stack still answers. Before an org goes `on`, a faster path to `off` is necessary. That path is the operator job `admin.set-org-feature` ([ADR-074](ADR-074-operator-jobs-and-the-console-database-role.md), [CTX-1646](https://linear.app/ctxpipe/issue/CTX-1646)): the operator console queues it, and the worker sets the value in seconds. The job sets only `off`: a value that enables a feature goes through the reviewed config. The log entry `org_features.set` holds the request id, who asked and who approved. A value that an operator sets is held: the config task does not change it until the config names the same value. Thus the next hosted update does not undo a fast `off`. The config PR that follows sets the entry to `off` and ends the hold; a later config PR enables the org again.
   - **One seam.** The tools call one knowledge reader interface with two implementations. The backend picks one for each request, and the worker picks the writers.
   - **Both stacks stay current.** While the flag is not `off`, the worker writes both stacks, so `on → off` needs no rebuild. ClickHouse serves a Workspace only when `knowledge_state` says that it is ready.
   - **Cursors.** A cursor records the stack that made it. A cursor from the other stack fails with a clear error.
   - **Order:** our own org first, then chosen customer orgs one at a time, each in `shadow` first.
   - **Data.** Each Jev call, embedding call and vision call goes only to a ZDR endpoint. Before the first org leaves `off`, the ZDR probe of [ADR-068](ADR-068-knowledge-retrieval-jev-layers.md) decision 7 passes. No other condition holds back the flag (the CTO, 2026-11-19). Shadow logs hold ids, scores and timings, no content.
   - **The end.** When all orgs are `on` and their metrics are at least as good, we remove the old stack, the dual write and the flag.

## Amendment 2026-11-22: hill-climb by generations, with no fixed target (CTX-1499)

The CTO, 2026-11-22: "We don't have hard targets, we want to hillclimb the retrieval for many generations until the improvements plateau. Every generation can be merged as we are behind feature flag."

- **A generation** is one change of the plane, with its run on the dataset.
- **The reference point of a change is the last kept generation of the plane.** A change of the plane is kept when it improves the eval over that generation, with no guard regression. The hold-out set still decides keep or revert (decisions 5 and 7): this amendment changes only the reference point.
- **No fixed target:** a change is not measured against a fixed number, and not against the baseline (the current stack, Postgres and FalkorDB). The baseline arm stays in each report, as a reference only.
- **The loop goes on** until the improvements plateau.
- **Each kept generation can merge**, because the `knowledge_plane` flag holds the plane back from customers (decision 9).
- **The labels:** one label version for each dataset (the knowledge evals README, "One label version for each dataset").
- **The question set v0:** the knowledge evals README ("The dataset") gives its file, its corpora and its counts.

## Consequences

- **Proof before switch:** each change has a measured effect before it reaches a customer, and the switch for each org is reversible.
- **Cost:** a one-time ingest for each dataset version, and double hydrate work for orgs in `shadow` or `on` during the trial.
- **Fit to the dataset:** many small improvements can fit the dataset too closely. The hold-out set and new questions over time limit this.
- **The first runs of the loop** measure the text embedding model (text-embedding-3-large since [CTX-1451](https://linear.app/ctxpipe/issue/CTX-1451), against the other candidates that the trust rule of ADR-068 decision 5 allows) and choose the vision model of ingest: how well its description, its text from the image and its Mermaid of a diagram let a question find the image ([ADR-068](ADR-068-knowledge-retrieval-jev-layers.md) decisions 5 and 6).
