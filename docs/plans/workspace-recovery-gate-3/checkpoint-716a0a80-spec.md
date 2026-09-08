# Gate 3 checkpoint 716a0a80 — Spec review

Pinned range: `bb24210c01e0dc1bcbc2d4fdf197d07a7a17035d...716a0a80a2679b74fb9a3dc1f18c57c93d3573a2` (29 commits, 1,645 files). This is an intermediate Gate 3 review, not gate acceptance.

## Finding

**[P1] Bound the root capture and extraction fan-out before starting per-root work.** The accepted ingest protocol says to “cap concurrency in code” (`.ai/scratchpad/git-backed-projects/issues/10-ingest-to-git-write-protocol.md:58`), and the checkpoint ADR says “The final command and each root capture are bounded” (`.ai/memory/decisions/ADR-033-native-durable-write-workflows.md:41`). Yet deterministic and model root results have no count or byte limit (`apps/backend/src/graphs/codeIngestionGraph/nodes/identifyRootsDeterministic.ts:72-77,124-329`; `identifyRootsAmbiguousAgent.ts:20-50`), and `repository-ingestion.ts:343-430` starts every root concurrently. Each root then starts nine extractor/provider operations concurrently before `runExtractRoot.ts:42-45,84-96` applies the first aggregate guard. A repository-controlled `workspace.json`, Rush manifest, or expanded workspace glob can therefore persist an unbounded `identify-roots` output, create two durable steps and up to nine simultaneous extractor calls per root, exhaust workflow-step capacity or memory, and incur large model/provider cost before the advertised 8 MiB/10,000/50,000 checks reject the final batch. Add a code constant limiting normalized roots, validate inside the `identify-roots` durable callback before it returns, and run roots/extractors through a bounded pool; prove both count rejection and the concurrency ceiling natively.

The new source-declaration path/blob fence, inherited semantic handoff, and retired projection cleanup otherwise match the implemented checkpoint scope. The earlier optional-`undefined` payload concern remains withdrawn: OpenWorkflow returns PostgreSQL JSONB-round-tripped step output on first execution and replay, and the pinned native regression covers that API shape.

Declared open retraction, endpoint mapping, live producer, and terminal-owner work was tracked as remaining scope rather than reported as a checkpoint regression.
