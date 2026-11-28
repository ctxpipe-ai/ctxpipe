# ADR-033: Graph ontology v2 — relation families, shared identity, deterministic connector extraction

**Status:** Accepted (revised 2026-10-13; revised 2026-11-26: Linear issue links by id, CTX-1716) | **Date:** 2026-09-17 | **Tags:** graph, ingestion, connectors, retrieval

Amends [ADR-032](ADR-032-path-located-graph-edges.md) §2 (predicates) and §4
(connector nodes). Builds on [ADR-031](ADR-031-github-pr-scoped-mirror.md).

**Amended by:** [ADR-037](ADR-037-committed-memory-reaches-the-graph.md) — §8:
`.ai/memory/lessons-learned.md` is an instruction source (tier 2).

## Revision (2026-10-13): intent trail

- **Reference family:** `RESOLVES` joins `REFERENCES`, `MENTIONS` and
  `SUPERSEDES`. `PullRequest RESOLVES Issue` is the edge for a merged pull
  request that closes the issue: the head branch names the issue, or a Linear
  closing keyword (close, fix, resolve, complete, and their forms, with an
  optional colon) comes directly before the identifier or its Linear URL,
  also inside a Markdown link or code span. Other mentions, revert pull
  requests, and pull requests closed without a merge stay `REFERENCES`.
- **Issue links:** Linear issues link to issues with existing predicates. A
  sub-issue is `PART_OF` its parent. For a relation that issue A owns,
  `blocks` gives `B DEPENDS_ON A`, `duplicate` gives `B SUPERSEDES A`, and
  `related` gives `A REFERENCES B`. Linear's own `similar` suggestions and
  unknown types are skipped. The milestone is an `Issue` property.
- **Resolution:** claims between two `Issue`s (`PART_OF`, `DEPENDS_ON`)
  resolve like reference-family claims (decisions 4 and 9): an issue that is
  not mirrored becomes a stub when its team is known, otherwise the claim
  drops.

## Revision (2026-11-26): Linear issue links by id

[CTX-1716](https://linear.app/ctxpipe/issue/CTX-1716). A Linear label file was
a node with no edge, so `get_related` from a label returned nothing.

- **Key:** each Linear mirror file has the key of its Linear id,
  `ent:linear:${id}`. A Linear id is a UUID, so the key holds no Linear
  workspace.
- **Edges:** a Linear issue states an edge to the key of each id in four
  keys of its front matter: `parentId`, `projectId`, `teamId` and
  `labelIds`. Other ids (for example `cycleId` and `assigneeId`) give no
  edge. The predicate tells containment (`PART_OF`) from classification
  (`HAS_LABEL`), and the kind of the target tells a parent, a project and a
  team apart:
  - `Issue PART_OF Issue` from `parentId` (the sub-issue rule of the
    2026-10-13 revision).
  - `Issue PART_OF Project` from `projectId`.
  - `Issue PART_OF Team` from `teamId`. This replaces `Team OWNS Issue` for
    the tracker team. Reason: the issue file states the edge, and a relation
    belongs to the file that states it (ADR-066 decision 5). In Linear, the
    team holds the issue, and the issue identifier starts with the team key,
    so the team is a container of the issue. `OWNS` stays for a `Team` that
    owns a package (CODEOWNERS).
  - `Issue HAS_LABEL Label` from `labelIds`, for each label (not only
    `area/…` and `component/…`). `HAS_LABEL` is the first predicate of a new
    family, classification. Reason: a label groups issues. It does not
    contain them (`PART_OF`), own them (`OWNS`) or name them in text
    (`MENTIONS`). The name has the form of `HAS_OPERATION` and
    `HAS_INSTRUCTION`.
- **No target:** an id with no mirrored file gives no edge. A mirror with a
  project scope does not write the team and the labels of its issues.
- **Knowledge plane only:** the knowledge plane makes these edges
  (`knowledge-plane/reference-keys.ts`). The old stack (the hydrate graph in
  FalkorDB) does not, because
  [CTX-1713](https://linear.app/ctxpipe/issue/CTX-1713) removes it. For the
  same reason, the old-stack registry (`allowedConnections.ts`,
  `extension.ts`) does not change. This revision is the record of these
  predicates.
- **Order:** this revision does not order the issues of a label by time. The
  walk keeps its fan-out order. A newest-first order needs a source update
  time on the plane, which the timestamp audit
  ([CTX-1718](https://linear.app/ctxpipe/issue/CTX-1718)) decides.

## Context

Customer graphs sat at roughly one edge per node: `InstructionUnit` stars on a
stub root Service, `Operation` stars on an API. Connector Markdown (Linear,
Notion, Slack, Confluence) reached the graph only by being LLM-read as
"instructions". Five declared kinds (`Concept`, `Capability`, `Topic`,
`Incident`, `Decision`) had no extractor. `ABOUT` carried four meanings. No
edge carried time although claims support validity. Evidence source ids on the
PR-mirror branch embedded the target hash mid-string and omitted repository
ids, which defeated evidence dedup, retraction and purge.

ctxpipe's product promise is an org-scoped graph that compounds with every
commit, decision and agent run. Compounding requires cross-tool edges, and
cross-tool edges require shared identity.

## Decision

1. **Kinds are real provider things.** New extension kinds: `Issue`, `Team`,
   `Thread`; `Decision` gains an extractor. `Concept`, `Capability`, `Topic`,
   and `Incident` are not declared until an extractor exists.
2. **Predicates come in families with fixed semantics** (`allowedConnections.ts`,
   `PREDICATE_DESCRIPTIONS`):
   containment `PART_OF`; provenance `DECLARED_IN`, `MEMBER_OF_PRIMARY`;
   change `TARGETS`, `ADDED`, `MODIFIED`, `REMOVED`, `RENAMED`; reference
   `REFERENCES`, `MENTIONS`, `SUPERSEDES`; ownership `OWNS`; cause
   `INFLUENCES`; classification `HAS_LABEL` (revision 2026-11-26). `ABOUT`,
   `RELATES_TO`, `ASSOCIATED_WITH` are retired. The extension traversal
   walks the reference, cause and ownership families.
   Containment also shapes a monorepo: a `Service`/`App`/`Library` is
   `PART_OF` its nearest enclosing package or the workspace root
   (`svc:…:./`), which is `IMPLEMENTED_IN` the `Repository` like every
   package (`linkPackageHierarchy`).
3. **Identity is shared.** `domain/codeIngestion/referenceResolver.ts` is the
   only place that turns URLs, identifiers and paths into keys:
   `prq:${repoId}:${n}`, `iss:linear:${IDENT}`, `team:linear:${KEY}`,
   `team:github:${org}/${slug}`, `thr:slack:${channel}:${ts}`,
   `dec:${repoId}:${path}`, `fil:${repoId}:${path}`. Bare Linear identifiers
   match only known team keys. Each Linear mirror file also has the key of
   its Linear id, `ent:linear:${id}` (see "Revision (2026-11-26)").
4. **Connector Markdown is parsed, never LLM-read.**
   A list of deterministic extractors is the only reader of connector Markdown; a
   connector ships its frontmatter contract and its extractor together.
   Source-repo extractors add `Decision` (ADR files) and `Team OWNS`
   (CODEOWNERS). Reference-family claims whose ends do not resolve are dropped
   once after all roots concatenate (`finalizeExtractedReferences`), with a
   per-predicate summary log.
5. **Time is first-class.** `ExtractedClaim` carries optional `validFrom` /
   `validTo`; change edges set `validFrom` to the merge date; containment is
   not asserted for a path a pull request removed.
6. **Evidence ids follow `${extractor}:${repositoryId}:…:${targetHash}`**
   (`domain/codeIngestion/evidenceSourceId.ts`). Cross-repository claims carry
   both repository ids and the warehouse path as segments.
7. **Connector-only partial diffs skip the code extractors**
   (`shouldSkipCodeExtractorForPartialDiff`).
8. **Instruction sources are files whose purpose is to instruct.** Agent files
   and rules, skills, `CONTRIBUTING`, the README at the repository root or a
   package root, and docs whose filename names a norm
   (`isInstructionSourcePath`). Every other Markdown file is search-only
   documentation; decision records become `Decision` nodes. On TruRec's
   preview, README-derived units were 64% of all nodes before this rule.
9. **References with a fully determined identity create stub nodes.** A
   pull request of a connected repository (`prq:${repoId}:${n}`) or a Linear
   issue of a known team (`iss:linear:${IDENT}`) referenced before it is
   mirrored becomes a stub (`inferredFromReference`) so the edge lands now; a
   later real extraction replaces the stub. References to unconnected
   repositories are still dropped. Linear issues whose mirror file lacks a
   team key derive the team from the identifier prefix, so no issue is
   orphaned by a failed relation fetch.
10. **Graph health is measured by join density** (`GET /knowledge-graph/quality`):
   share of objects with evidence from two or more extractors, plus orphan
   rate, evidence rows per claim, kind and predicate counts, and the count of
   leftover connector-derived instruction units. A healthy full ingest
   (decision 11) retracts those leftover units; there is no second cleanup
   path. Cross-family edge share, PR→Issue link rate, File containment,
   dead-kind count, freshness, and per-ingest logging are not in this
   release. Extracted-claim `sourceUrl` persistence and per-kind embedding
   extras (PR changed paths, Decision status) are deferred.
11. **A full ingest is authoritative for what its repository asserts.** Dedup
   touches every re-observed evidence row (`touchEvidenceBulk`: `observedAt` to
   now, source id to the current commit) and stamps new rows at write time.
   When codesearch ran in full mode and no index degraded, the workflow sweeps
   this repository's evidence observed before the index child's `indexedAt`
   (stamped by the same worker after checkout and before any extraction, and
   cached for runs already in flight when the worker is redeployed)
   (`retractUnobservedRepositoryEvidencePg`): claims left without proof go,
   nodes no claim references go with them, multi-source claims keep their other
   proofs. The sweep also requires that no extractor skipped a file on LLM
   failure (`extractionSkippedFiles === 0`), since a skipped file's facts
   would otherwise read as unobserved. The producer is the second source-id
   segment, so another
   repository's claims that merely mention this one survive. The cutoff is
   time, not the commit hash: a re-index at an unchanged tip re-observes at the
   same hash as the stale rows. Manual re-index (UI button,
   `reindex-repositories`) requests `fullReingest`, which ignores the last
   ingested commit; webhook ingests stay incremental and keep using path-based
   retraction. Before this, a re-index at an unchanged tip was a partial ingest
   with an empty diff: extractors re-ran, nothing was retracted, and LLM naming
   drift accumulated (TruRec production carried instruction-unit evidence from
   586 distinct ingestion hashes).

## Rationale

- Ten extractors that each emit their own stars do not compound; one resolver
  that glues them onto shared `PullRequest`, `File`, `Service`, `Team` nodes does.
- Distinct relation families let the planner and traversal compose paths with
  a stable meaning (`PullRequest MODIFIED File PART_OF Service` reads as "the
  PR touched the service"); one overloaded predicate cannot.
- Renaming predicates before release costs a find-and-replace; afterwards it
  costs a re-projection per customer graph.
- The LLM stays where it adds information that is not already written down:
  package classification, structure identification, and later promotion of
  recurring review comments into norms.

## Consequences

- Full re-ingest of connected repositories is required for `File PART_OF`,
  `Decision`, `Team` and connector nodes to appear. The re-ingest itself
  removes everything the new extractors no longer assert (decision 11), so the
  graph after rollout reflects the current code only.
- FalkorDB serverless sleep can drop the shared graph connection; the client
  logs the error and reconnects on the next call (`platform/graph/client.ts`).
- A full ingest that degrades (search or SCIP index unavailable) completes
  with issues and skips the sweep; stale evidence then waits for the next
  healthy full ingest rather than being removed on partial information.
- The hosted GitHub App must subscribe to review, review-comment and
  issue-comment events and hold Issues: Read (ADR-031).
- `Issue` identity is org-scoped by identifier; two Linear workspaces with
  colliding team keys in one org would merge issues (known limitation).
- Bare-identifier matching in PR text depends on `Team` nodes already existing;
  the first ingest of a context repository links by URL only.
- `Document` (Notion / Confluence), `Incident`, `Person`, and the promotion
  pass are deliberately out of this decision. `Incident` is not a declared
  kind until an extractor exists.

## Alternatives considered

- **Keep `ABOUT` for everything structural** — rejected: traversal and planner
  cannot distinguish containment from aboutness.
- **Generic `Document` node for every connector file** — rejected for typed
  provider kinds; retained as the plan for pages without a join key.
- **LLM entity extraction over connector bodies** — rejected as the primary
  path; it recreates the star at higher cost. Kept as a later linking fallback.
- **Dropping every unresolved reference** — the first preview run measured a
  zero Issue-to-PR link rate without the mirror, so stubs were adopted for
  identities that are fully determined by their key (decision 9).
