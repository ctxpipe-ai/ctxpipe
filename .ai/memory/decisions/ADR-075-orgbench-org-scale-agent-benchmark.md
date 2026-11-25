# ADR-075: OrgBench measures context engines with real agent harnesses on public org twins

**Status:** Accepted (the CTO, 2026-11-25; nothing is built yet) | **Date:** 2026-11-25 | **Tags:** evals, benchmark, mcp, knowledge, harbor, competitors | **Ticket:** [CTX-1659](https://linear.app/ctxpipe/issue/CTX-1659) | **Plan:** [OrgBench plan](https://linear.app/ctxpipe/document/orgbench-plan-964f4e6e4395)

## Context

[ADR-069](ADR-069-knowledge-plane-evals-and-rollout.md) measures retrieval: questions in, ranked units out. It does not measure an agent that works with the ctxpipe MCP in a real harness. [ADR-051](ADR-051-mcp-read-surface.md) asks for "tests and evals for each tool". The MCPJam suite (`apps/backend/evals/mcp/`) was to supply the evals. It has 22 cases in an emulated model loop on synthetic fixture orgs. Its `baseline.json` is null, and its runs have failed since 2026-10-20 ([CTX-1045](https://linear.app/ctxpipe/issue/CTX-1045)).

Public results show these facts:

- No public benchmark has tasks that need discovery across tens or hundreds of repositories.
- No public benchmark has code work that depends on knowledge that is not code, for example a chat decision, a ticket, or an RFC.
- "All sources as local files + grep" is a strong baseline in three independent results. In one, the files beat the vendor's MCP. In another, files and a read-only CLI beat MCP tools by 7.85 points with about 21% fewer tokens. Independent work often shows no gain or a loss from a context MCP on fixes in one repository.
- Agents often do not call the tool. In one study, 58% of the trials never called it.
- A pass@1 of one run moves 2 to 6 points between runs. A change of the harness version alone moved one model by 2.3 points.
- An internal partner eval showed a gain only for Sonnet, and only on questions across repositories. Opus had no gain. Haiku had no gain, because 14% of its calls failed our argument schema.

We must know whether ctxpipe helps a real agent on org-scale work, where it helps, and what it costs. We must also have a signal that we can climb.

## Decision

1. **Three levels.**
   - **L0, retrieval:** the evals of ADR-069 (recall, nDCG, a correct "no answer"). L0 is the main climb signal, because it is cheap and has low noise.
   - **L2, agent tasks:** a production harness in a container, on an org twin. The run varies the arm, the model and the trial. L2 is the benchmark, and it is the guard and the truth check of the climb.
   - **L3, external:** a 20-task set of CodeScaleBench on repository sets of medium size. It is a sanity check only, because its gold answers are public.
   - There is no tool-surface level (L1). Tool choice and argument errors come from the L2 transcripts and the MCP spans.
2. **Org twins.** A twin is a public org at a frozen snapshot: its repositories, its issues and pull requests, its doc, RFC and ADR repositories, and its chat as Markdown. Zulip is the first twin. A scale sweep runs the same tasks with 5, 50 and 200 repositories (distractor repositories from other public orgs fill the gap).
3. **Arms.** Only the context arm changes in a comparison. The harness version, the model, the preamble shape, the budgets and the snapshot stay the same.
   - **B1+ is the primary comparator:** all org repositories at T, plus the docs, issues and chat as Markdown, in the workspace. The comparator is not "no context", because files + grep is the strong baseline that the evidence shows. A loss to B1+ is product information.
   - **CTX:** an empty workspace (or the one repository of the task) and the ctxpipe MCP.
   - **ORACLE:** the gold context in the prompt, 1 trial. It calibrates the task and shows the headroom.
   - Each competitor arm gets its own vendor guidance.
   - Every arm gets the same neutral preamble shape. The preamble of B1+ tells where the files are. An egress allowlist blocks web tools. The harness version is pinned. The run reports its concurrency, and the CTX concurrency stays at the level of a real customer team.
4. **Natural tasks.**
   - The task text comes from what people really asked after T: issues, chat threads and pull request threads.
   - We remove only direct leaks: ids, titles and gold paths.
   - **The BM25 leak lint of the ADR-069 question set does not apply to agent tasks** (the rule "No words of the gold" in [`apps/backend/evals/knowledge/README.md`](../../../apps/backend/evals/knowledge/README.md)). That lint removes exactly the questions that grep answers well, so it builds a ctxpipe win into the benchmark. Each task has a `lexical_hook` field (yes or no), and the report shows that stratum.
   - A memorization probe drops a task when the model names the answer from the prompt alone.
5. **Org-scale tasks: two sources or more.** The gold evidence of each task spans two sources or more, or two repositories or more. A task that does not is tagged as a control (for example the harm control in one repository).
6. **Time-clean snapshot.**
   - The snapshot is frozen at T.
   - T is after the training cutoff of each model that we test **and** of each ingest model.
   - The bench org has no live sync.
   - We filter out issue and chat bodies that were edited after T, and strip git history after T.
   - A task records `answerable_at_T`. Freshness tasks, where it is "no", are a separate family.
7. **The arm's own service errors are failures.** A 5xx, a 429 or a timeout of the arm's own service counts as a failure of that arm. Only model API errors and harness crashes are retried as infrastructure errors. The report gives both numbers. A competitor arm uses the same rule.
8. **Grading and judging.**
   - Machine grading comes first: tests, set-F1 against mined keys, and linters.
   - The judge panel grades only claims rubrics. It has three model families and never only the family under test ([ADR-063](ADR-063-visual-critic-decides-with-jev.md), [ADR-069](ADR-069-knowledge-plane-evals-and-rollout.md)). Jev is never a judge.
   - Before the panel judges, citations are normalized to source URLs, and the arm is blinded.
   - The judge is calibrated against about 100 human labels, and again when a judge model changes.
   - Each grader passes a calibration triad: a null answer scores 0.1 or less, the gold answer 0.9 or more, and a keyword dump 0.5 or less. A task with an ORACLE pass rate of 0% is broken.
   - A grader change is applied with `rescore`, with no model calls.
9. **Keep rule.** A change of the product is kept when both conditions are true:
   - it wins at L0 (hold-out recall or nDCG), or on an L2 process metric (argument errors, tool adoption);
   - at L2 it is non-inferior on success, cost and harm. A margin for each metric is set before the run. The confidence bound of each metric must exclude a loss that is larger than its margin. An inconclusive result does not keep the change.

   The reason is power. Tasks are in the 30–70% band. The minimum detectable effect is then about 40 points at 20 tasks × 1 trial and about 10 points at 120 × 3. At a full release with 5 trials, it is about 5–7 points. L2 cannot find the small wins of one climb step. Continuous scores, the B1+ score as a covariate (CUPED), and a re-run of only the tasks that called the changed tool make the minimum detectable effect smaller. A large L2 win is confirmed at release size before we make a claim.
10. **Harbor is the only runner. MCPJam is removed (D1).**
    - Harbor runs production CLIs in a container for each task, with test-based verifiers and remote HTTP MCP servers with headers. CodeScaleBench and SlackBench run on it, and its task format is public. We use the stock Harbor `claude-code` agent with native `mcp_servers`.
    - MCPJam (code read at commit `82a6acb`) does not fit:
      - Its real harnesses run only in the hosted E2B path and the local-native path. Both are behind feature flags in a limited rollout. The local CLI and the SDK runner are emulated only.
      - It relays the MCP calls of Codex and OpenCode through MCPJam, not through the vendor's own client. That is not fair to those arms.
      - It has no repository or task fixture, and it does not grade the workspace.
      - Its eval runner is under an Enterprise license. Each SDK and CLI run needs an MCPJam credential and is metered for each iteration, also with our own model keys. Hosted runs have at most 10 iterations and 2 concurrent runs for each org.
    - [CTX-1663](https://linear.app/ctxpipe/issue/CTX-1663) removes `apps/backend/evals/mcp/`, `@mcpjam/sdk`, its workflow and its checks. Our analyzer gets the tool-call checks from transcripts and MCP spans, and it copies the paired comparison design of MCPJam. A plain MCP SDK client test replaces the MCPJam conformance test where other tests do not cover the protocol.
    - We do not rebuild the CodeScaleBench `configs/`.
11. **Spend: caps and campaigns on demand (D3).**
    - No run has a schedule: no daily, weekly or monthly run.
    - A climb is a campaign of generations. It runs when the benchmark is ready, and again when a significant change is worth a climb. A public release is also on demand.
    - Climb generations use Haiku 5.5, campaign end checks and releases use Sonnet 5.5, and Opus 5.5 runs only on a small hold-out sample. Baseline arms are cached by task, snapshot, harness version, model and arm config. A B1+ sentinel of 10 to 20 tasks in each batch refreshes the cache when it drifts.
    - Each run has a spend cap. The first caps are estimates: $2 for the spike, $80 for the first baseline, $5–20 for a climb generation, $20 for a campaign end check, and $100 for a public release. The spike measures the real cost. When a run does not fit its cap, we cut tasks or trials, not the cap.
    - Runs go through `factory eval bench:*` on the host, as for ADR-069.
12. **Publication (D2).**
    - The tasks, the runner, the graders and the report format are public. The factory adds the cache, the spend caps and the gate.
    - A sealed test split and one held-out twin stay private and run only at a release. The hold-out results are aggregates only.
    - A competitor result has a date and runs again at each release.
    - **A vendor whose terms forbid the publication of results is run but withheld** in the public table. The table links the exact clause and points to the public repository, so that anyone can run the comparison. Greptile (terms of 2026-10-17, §1.4(a)) is the known case. We read the terms of the other vendors before the first public release.
    - Transcripts are published as pointers and hashes where the content license is not clear.
13. **CTO decisions (2026-11-25).** D1 is decision 10, D2 is decision 12, and D3 is decision 11.
    - **D2, reason:** the CTO's position is that a comparison is not a use of the service to build a competing service.
    - **D4, production:** the CTX arm runs on a bench org in production for baselines and releases. Production cannot serve an unmerged candidate, so a candidate runs on a local stack. For a candidate, freeze the context repo, hydrate it into the candidate build, and point the harness at the local MCP.
    - **D5, retrieval backend:** every CTX run uses only the ClickHouse + Jev knowledge plane (the `knowledge_plane` path of ADR-066 to ADR-069). OrgBench ignores the FalkorDB-backed retrieval completely: it is not an arm and not a baseline. **A run that touches FalkorDB is invalid.**
14. **Credentials of the CTX arm.** Public twin text can contain a prompt injection, and the transcripts become public. Thus:
    - The CTX arm uses only a read-scope key. The org set of its grant ([ADR-051](ADR-051-mcp-read-surface.md)) is only the bench org.
    - The key belongs to a bench user that is a member of no other org.
    - Arm configs read the key from the environment. No published config or transcript holds a key.
    - Each artifact goes through the secret scrub of [ADR-072](ADR-072-scrub-secrets-before-every-model-call.md) before we publish it.

## Consequences

- ADR-051's requirement of evals for each tool is met by the L2 transcripts and MCP spans, not by a separate tool-level suite.
- The first results can show that B1+ beats CTX on a small org. The scale sweep shows where files + grep stops working, and the report shows each stratum.
- L2 is too noisy to steer small steps. L0 and the L2 process metrics steer, and L2 guards with non-inferiority. A public claim needs a release-size run.
- The benchmark adds code under `apps/backend/evals/bench/`, next to `evals/knowledge/`, so that it uses the same panel, metrics and report code. It moves to its own public repository before the first publication.
- A competitor arm can need a headless login that the vendor does not supply. That arm waits.
- Tasks age as models train on newer data. A refresh before each campaign mines new tasks after a new T and retires old tasks.

## Alternatives considered

- **MCPJam as the runner:** rejected (decision 10).
- **The CodeScaleBench `configs/` rebuild:** rejected. The public `configs/` are not complete, and its MCP arm has a tuned preamble that the baseline arm does not have.
- **"No context" as the primary comparator:** rejected. It overstates the gain, because files + grep is the strong baseline.
- **The BM25 leak lint on agent tasks:** rejected (decision 4).
- **Scheduled runs:** rejected by the CTO (D3).
- **A FalkorDB arm:** rejected by the CTO (D5).
