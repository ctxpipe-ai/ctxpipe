# Graph overhaul proposal: a compounding engineering graph

**For:** Jakub  
**From:** Tom / graph + GitHub PR work  
**Date:** 2026-09-16  
**Status:** Proposal. Decisions requested in §11.  
**Supersedes:** the earlier architecture question in this directory (removed; its layer table and A / B / C options are folded into §2 and D1). Implemented on branch `graph-overhaul`; decisions recorded in ADR-033.  
**Related:** ADR-018 (unified connections), ADR-022 (Linear git-native), ADR-025 (Slack capture), ADR-028 (assets), ADR-031 (PR scoped mirror), ADR-032 (File as location)

---

## 0. Summary

ctxpipe.ai sells an "org-scoped graph that compounds with every commit, decision, and agent run". Today the graph is a set of per-repository fact stars: `Service → InstructionUnit`, `Service → Library`, one edge per node. Connector content (Linear, Slack, Notion, Confluence) is not on the graph at all except by accident, five declared kinds have no extractor, no edge carries time, and nothing links a pull request to the issue that motivated it or the team that owns the code. That is why customer graphs sit at roughly one edge per node.

The `github-pr-mirror` branch is the right first move: it makes `File` a shared location and gives `PullRequest` deterministic change edges. This proposal turns that move into the system:

1. **Kinds are real provider things** with canonical identity (PR, Issue, Thread, Decision, Team, Document). No kind is minted by reading a dump as rules.
2. **Identity is shared.** One reference resolver turns URLs, identifiers and repo paths into graph keys. Every connector joins to every other through it. This is where compounding comes from.
3. **Predicates come in families** with fixed semantics: containment, provenance, change, reference, ownership, cause, norm. `ABOUT` stops meaning four things.
4. **Time is first-class.** Change edges carry the merge date; containment carries validity. The schema already supports it.
5. **Deterministic first.** The LLM does promotion (recurring review comments become instruction units, opened as a PR), linking, and summaries.

Do the schema-affecting parts now, on this branch, before anything ships: predicate names, evidence keys, validity plumbing. Renaming predicates after release means re-projecting customer graphs. Renaming them now costs nothing. Stack the connector extractors on top in the same release so customers re-ingest once.

North-star metric: **join density**, the share of nodes with edges from two or more source families. Not nodes-to-edges.

---

## 1. The vision, stated as questions the graph must answer

Verbatim from ctxpipe.ai: *Perception* "watches every commit, doc, incident, and agent run"; *Knowledge* is an "org-scoped graph that compounds with every commit, decision, and agent run"; *Intelligence* is "one MCP endpoint, GraphRAG reasoning"; the loop is "ingest → graph compounds → agents retrieve → outcomes captured". Concepts named: ownership, dependencies, standards, ADRs, prior decisions, incidents, review in PRs.

An agent calling `ctx_advisor` needs these answered with paths through the graph, not with a search hit list:

| # | Question an agent asks | Graph path that answers it | Today |
|---|---|---|---|
| Q1 | Why is service X built this way? | `Decision INFLUENCES X`; `Issue REFERENCES PullRequest MODIFIED File PART_OF X`; PR review text via evidence `sourceUrl` | No `Decision` extractor. No Issue. PR edges on branch only. |
| Q2 | What changed in X recently, and who reviewed it? | `PullRequest MODIFIED File PART_OF X` filtered by `valid_from >= t`; `review_decision` on PR | Branch, but no time on edges |
| Q3 | Which standards apply to the files I am editing? | `InstructionUnit DECLARED_IN File`, `Service HAS_INSTRUCTION`, norms inherited along `PART_OF` | Partly (Service level only) |
| Q4 | Who owns X? | `Team OWNS X` (CODEOWNERS, Linear team) | Nothing |
| Q5 | Is there prior work or discussion on this? | `Thread REFERENCES PullRequest`; `Issue REFERENCES PullRequest`; `Document MENTIONS File` | Search only |
| Q6 | What incidents touched X, and what fixed them? | `Incident AFFECTS X`, `Incident RESOLVED_BY PullRequest` | `Incident` kind declared, never emitted |
| Q7 | Fleet-wide, who still uses library L / writes to DB D? | `claim_aggregation` over `USES_LIBRARY`, `WRITES_TO` | Works today |
| Q8 | What did agents learn from doing this before? | Outcomes as evidence on norms (Phase 3) | Nothing |

Q1, Q4, Q5, Q6 are the product promise and they are all cross-tool joins. Search cannot answer them because search returns documents, not paths.

---

## 2. Where we are (verified against the branch on 2026-09-16)

**Kinds and how they enter the graph**

| Kind | Layer | Emitted by | Typical degree |
|---|---|---|---|
| Service, App, Library | core | `extractKind` (deterministic, LLM fallback) | hub |
| API, Operation | core | `identifyAPIs` (LLM) | 1 (`HAS_OPERATION` star) |
| Database, Stream, Infrastructure, Library | core | `identify*` (LLM) | 1 |
| Pattern | core | `identifyPatterns` (LLM, 0.6) | 1 |
| InstructionUnit, Skill | extension | `extractInstructionUnits` (LLM per `.md`) | 1 (`HAS_INSTRUCTION` star) |
| PullRequest, File | extension | branch: PR extract + `linkLocatedPaths` (deterministic) | File is the first join node |
| Concept, Capability, Topic, Incident, Decision | extension | **nothing**. Declared in `retrieval/schema/extension.ts`, no extractor emits them | dead |

**The 1:1 star, mechanically.** `extractInstructionUnits` globs `**/*.{md,mdc}` (cap 10,000 files) and LLM-reads each candidate into units hung on `svc:${repo}:./`. Context repositories are Markdown-only, so every Linear issue, Notion page and Slack thread became "instructions" on a stub root Service. TruRec AI reportedly reached ~4k such units (not re-verified; measure before re-ingest, §8). The branch stops the flood by skipping connector prefixes. It does not add anything in their place.

**Connector content has no typed path to the graph.** Linear, Notion, Slack and Confluence write structured frontmatter into the context repository and trigger ingestion (ADR-028 §6). No extractor reads that frontmatter. The PR mirror on this branch is the first one that does.

**`ABOUT` is overloaded.** After the branch it means aboutness (`Concept → Service`), targeting (`PullRequest → Repository`), containment (`File → Repository | Service`), and provenance (`InstructionUnit → File`). The extension traversal whitelists `ABOUT` (`retrieval/services/graphTraversal.ts:12`), so a "semantic" hop now crosses containment. The planner sees predicate labels only (`retrieval/schema/llm-prompt.ts`), no descriptions.

**No edge carries time**, although `claims.valid_from` / `valid_to` exist, projection writes them to Falkor, and traversal filters on `validAt`. `ExtractedClaim` has no validity fields, so `mergedAt` is discarded at extraction.

**No ownership, no people, no cross-tool edge of any kind.**

**The branch's evidence keys break dedup and retraction.** `deriveLogicalSourceKey` strips a trailing `:${targetHash}`; the new source ids embed the hash mid-string and omit the repository id (`pull-request-mirror/graph.ts:158`, `linkLocatedPaths.ts:191`). Every re-ingest appends evidence rows, and retraction / purge cannot find PR claims. Must be fixed regardless of anything else here.

**Cost.** A context-repository ingest runs the full `identify_*` LLM suite even when the only change is one mirrored PR file, because root `./` is always kept by `narrowRootsForPartialDiff`.

**What the previous analysis got right.** A Linear issue is not `AGENTS.md`; running the instruction LLM over connector dumps was a category error; search still sees everything warehoused. **Where this proposal differs:** "typed extract when you want them on the graph" treated the cross-tool graph as optional. It is the product.

---

## 3. Design principles (the structure, in plain language first)

**P1. Every kind is a real thing in a provider, with a provider identity.** Issue, PullRequest, Thread, Document, Decision, Team, File. Never a kind minted by interpreting text as something it is not. *Structure:* each connector is a functor from the provider's schema (its entity types and relations) into our ontology; kinds are images of provider types.

**P2. Identity is canonical and shared.** One resolver maps `github.com/o/r/pull/42` → `prq:${repoId}:42`, `ENG-123` → `iss:${conn}:ENG-123`, a repo path → `fil:${repoId}:${path}`. Every extractor uses it. *Structure:* the same real thing appears in several provider schemas (a PR in GitHub, as a Linear attachment, as a Slack link). The resolver is the gluing along shared identity. Without it the graph is a disjoint union of per-tool graphs and nothing compounds. With it, every new connector attaches to existing nodes through URLs it already carries.

**P3. Predicates come in families with fixed semantics, and diagrams commute.** Containment is a partial order (transitive, used for scoping). Reference is a plain relation (no transitivity). Change is time-indexed. Norms apply along containment. *Structure:* the functor must be faithful on relation families: distinct provider relations must not collapse into one predicate. Where two paths exist between the same nodes they must agree, and we test that: `File → Service → Repository = File → Repository`; `Service → InstructionUnit → File → Service = identity`.

**P4. Time is first-class.** Structure claims have validity; change edges are dated events. A removed file is not "part of" a service at 0.95 confidence forever.

**P5. Deterministic first.** Frontmatter, URLs, paths and CODEOWNERS are parsed, never guessed. The LLM has three jobs: promotion (evidence → norms), linking where lexical match fails, and summaries for embeddings. It never mints kinds from dumps.

**P6. Search sees everything we warehoused; the graph contains only kinds we meant to extract, and every node earns its place** by having a join (an edge into another family) or a bounded hierarchy (Issue in Project in Team).

**P7. Evidence is retractable per file.** Keys are `${extractor}:${repositoryId}:…:${targetHash}` so the existing needle and path-regex retraction works, and a cross-repository claim carries both repository ids.

---

## 4. Options considered

### D1. How connector entities enter the graph

| Option | What | For | Against |
|---|---|---|---|
| A. Search-only | Warehouse + Zoekt, no nodes (what the branch does for Linear/Notion/Slack/Confluence) | Honest, zero cost, no fake kinds | Q1, Q4, Q5, Q6 unanswerable. Contradicts the product promise |
| B. Instruction LLM | Status quo before the branch | Cheap to keep | The 1:1 star. Category error. Rejected |
| C. Typed deterministic extract per connector | Frontmatter → `Issue`, `Thread`, `Team`, `Project`, `Document` + reference edges | Precise, cheap, joins via existing URLs; the PR extractor is the template | One extractor per connector; scope of kinds must be governed |
| D. One generic `Document` kind + reference layer | Every connector file is a `Document{source,type}`; edges only from URL joins | Minimal vocabulary, fast to ship | Loses provider semantics (an Issue's state, team, project); planner cannot reason by kind |
| E. LLM entity/relation extraction over text (GraphRAG-style) | Extract entities and relations from bodies | Finds links deterministic parsing misses | Expensive, hallucination, the star in another shape |

**Recommendation: C, with D for pages, E only as a confidence-tagged linking pass later.** Typed kinds where a provider type maps to an ontology kind (Issue, Project, Team, PullRequest, Thread, Decision, Incident). `Document` for Notion, Confluence and Linear documents, with hierarchy from paths. Scope is already curated in git (`linear/config.yaml`, Notion/Confluence config), so node volume is bounded by what customers chose to mirror. Slack captures are intentional and few: all become `Thread`.

Sub-choice: emit *all* in-scope Issues (C1) or only Issues that link to a PR (C2)? **C1.** Every Issue gets `PART_OF Project` and `OWNED_BY Team` deterministically, which is a real hierarchy, not a fake kind, and hybrid search can anchor on an Issue and walk to code. C2 would make "what is planned for X" unanswerable.

### D2. Predicate vocabulary

| Option | For | Against |
|---|---|---|
| Keep `ABOUT` for everything structural (ADR-032 as written) | No new names | Four meanings; traversal and planner cannot distinguish; composites meaningless |
| Typed families (recommended) | Traversal per family; planner gets semantics; commutation testable | ~6 new predicates; rename on this branch |
| Fully typed per kind pair (`FILE_IN_SERVICE`, …) | Maximal precision | Vocabulary explosion; no reuse |

**Recommendation: typed families.** Rename now: this branch is unreleased, so the rename is a find-and-replace. After release it is a Postgres update plus Falkor re-projection per customer.

### D3. Identity and references

| Option | For | Against |
|---|---|---|
| Per-extractor parsing | Local, simple | Divergent keys; joins break silently |
| Shared reference resolver (recommended) | One grammar, one key function, testable | One more module |
| Resolver + stub nodes for unresolved references | Edges land even before the target is mirrored, enriched later | Can create Issue → stub-PR pairs |

**Recommendation: resolver, plus stubs only for `PullRequest` and `Issue` whose repository / workspace is connected to the org.** Their identity is fully determined by the URL or identifier, and the existing `inferredFromConsumer` merge rule (`retrievalObjectWrite.ts:50`) already handles stub-then-enrich. Everything else unresolved stays as `sourceUrl` on evidence.

### D4. Time

| Option | For | Against |
|---|---|---|
| Snapshot only (today) | Simple | "What changed" unanswerable; removed files stay "present" |
| Validity on containment + event date on change edges (recommended) | Uses existing columns and traversal filter | Day precision (`date` columns) |
| Full bitemporal | Complete | Migration and query complexity nobody needs yet |

### D5. People and ownership

| Option | For | Against |
|---|---|---|
| None | No privacy surface | Q4 unanswerable; "links services to owners" is on the site |
| `Team` only (recommended now) | CODEOWNERS and Linear teams are deterministic; low privacy risk | Individual reviewers not modelled |
| `Team` + opt-in `Person` (handle-based, later) | Reviewer / assignee / author joins across tools | Privacy policy per org; ADR-025 forbids Slack user ids |

### D6. Where the LLM sits

| Option | For | Against |
|---|---|---|
| Extraction-first (today's `identify_*` on everything) | Finds structure in code | Cost per ingest; star-shaped output; cannot read connector dumps correctly |
| Deterministic-first, LLM for promotion / linking / summaries (recommended) | Cost proportional to new evidence, not to files; norms are minted from evidence with URLs | Needs a promotion job and a review path |

### D7. Delivery: what goes in this branch

| Option | For | Against |
|---|---|---|
| Merge the branch after fixing blockers; everything else later | Small review | Ships `ABOUT` and hash-mid keys, then migrates them; customers re-ingest twice |
| This branch absorbs every schema-affecting change; extractors stack on top in the same release (recommended) | One re-ingest; rename is free; extractors are additive and independently testable | Larger branch; parallel stacked PRs need discipline |
| One branch with everything | Single review of the whole design | Weeks unmerged; blocks other work on the ingestion path |

**Recommendation: the middle.** Everything that changes graph schema, evidence keys, or forces re-ingest lands on `github-pr-mirror` (Phase 0). The resolver and the Linear / Slack / Decision extractors are stacked branches that merge behind it and ship in the same release train (Phase 1). There is no technical dependency stopping Phase 1 from starting today on top of Phase 0.

---

## 5. Target ontology v2

### 5.1 Kinds by family

| Kind | Family | Identity key | Source | Phase |
|---|---|---|---|---|
| Repository | Structure | `repo_…` (product row) | GitHub | exists |
| Service, App, Library | Structure | `svc\|app\|lib:${repoId}:${root}` | `extractKind` | exists |
| API, Operation, Database, Stream, Infrastructure | Structure | as today | `identify*` | exists |
| **File** | Structure (location) | `fil:${repoId}:${path}` | link pass, PR extract | branch |
| Pattern | Norm | `pat:…` | `identifyPatterns` | exists |
| InstructionUnit, Skill | Norm | `inu:…`, `skl:…` | `extractInstructionUnits`; promotion pass | exists / P2 |
| **Decision** | Why | `dec:${repoId}:${path}` | ADR files: MADR frontmatter `status:`, this repo's `**Status:** … \| **Date:** …` header; LLM fallback for free-form | P1 |
| **PullRequest** | Change | `prq:${repoId}:${number}` | `github/pulls/` | branch |
| **Issue** | Work | `iss:${connectionId}:${identifier}` (uuid in payload) | `linear/issues/`; later Jira, GitHub issues | P1 |
| **Project** | Work | `prj:${connectionId}:${id}` | `linear/projects/` | P1 |
| **Team** | Actor | `team:${connectionId}:${id}`; `team:github:${org}/${slug}` | `linear/teams/`, CODEOWNERS | P1 |
| **Thread** | Discussion | `thr:${connectionId}:${channelId}:${threadTs}` | `slack/channels/` | P1 |
| **Document** | Knowledge | `doc:${source}:${connectionId}:${externalId}` | `notion/`, `confluence/`, `linear/documents/` | P2 |
| Incident | Why | `inc:${source}:${connectionId}:${id}` | PagerDuty connector (future); opt-in Slack incident captures | P2 contract, P3 data |
| Person | Actor | `per:${connectionId}:${handle}` | opt-in only; never Slack user ids | P3 |
| Concept, Topic, Capability | — | — | no extractor. **Remove from allowed connections and the planner schema** until one exists | P0 |

Identity notes. Linear identifiers can change when an issue moves team; Linear keeps the old one as an alias, and the uuid in payload lets the resolver map both. A PR key uses the source repository id when the repository is connected, else `prq:github:${owner}/${repo}:${n}` (branch behaviour), so keys upgrade when the repository is connected later.

### 5.2 Predicates by family

| Family | Predicate | Subject → Object | Semantics | Transitive | Temporal |
|---|---|---|---|---|---|
| Containment | `IMPLEMENTED_IN` | Service/App/Library → Repository | exists | yes | evergreen |
| Containment | `PART_OF` | File → Service/App/Library; File → Repository; Document → Document (page tree); Issue → Project | subject is inside object | yes | validity (`valid_to` when removed) |
| Provenance | `DECLARED_IN` | InstructionUnit → File; Decision → File; Skill → File | stated in this file | no | evergreen |
| Norm | `HAS_INSTRUCTION`, `MEMBER_OF_PRIMARY`, `IMPLEMENTS_PATTERN` | as today | exists | no | evergreen |
| Change | `ADDED`, `MODIFIED`, `REMOVED`, `RENAMED` | PullRequest → File | change event | no | `valid_from` = merged date |
| Change | `RENAMED_FROM` | File → File | new path came from old path | chains | dated |
| Change | `TARGETS` | PullRequest → Repository | the PR's base repository | no | dated |
| Reference | `REFERENCES` | Issue ↔ PullRequest; Thread → PullRequest/Issue/Document/Decision; Document → PullRequest/Issue | explicit URL or identifier link; payload `state` when the provider gives one | no | observed |
| Reference | `MENTIONS` | Issue/Thread/Document/Decision/Incident → File/Service | exact lexical hit on a known path or package name | no | observed |
| Reference | `SUPERSEDES` | Decision → Decision | "superseded by" text | chains | dated |
| Ownership | `OWNS` | Team → Service/App/Library/File/Issue/Project | CODEOWNERS rule, Linear team | inherited along `PART_OF` | validity |
| Cause | `INFLUENCES` | Decision → Service | exists, now emitted | no | dated |
| Cause | `AFFECTS`, `RESOLVED_BY` | Incident → Service; Incident → PullRequest | future connector | no | dated |
| Aboutness | `ABOUT` | reserved for semantic aboutness only (Document → Service via linking, P2) | LLM or lexical, low confidence | no | observed |

Retired uses: `PullRequest ABOUT Repository` → `TARGETS`; `File ABOUT *` → `PART_OF`; `InstructionUnit ABOUT File` → `DECLARED_IN`. All three exist only on this branch.

### 5.3 Traversal laws per family

- Containment is collapsed for scoping: anchoring on a Service includes its Files; a norm declared in a File applies to its containing package.
- Reference edges are hop-limited (1–2) and never expanded transitively.
- Change edges are filtered by `valid_from` when a question has a time horizon, and aggregated (`claim_aggregation` over `MODIFIED` gives hot files per service).
- `extension_traversal` becomes family-parameterised (`families: ["reference","cause"]`) instead of a fixed predicate whitelist.

### 5.4 Reference grammar (the resolver)

| Input | Resolves to | Notes |
|---|---|---|
| `https://github.com/{o}/{r}/pull/{n}` | `prq:${repoId}:${n}` or `prq:github:{o}/{r}:${n}` | Linear `githubReferences[].url` already carries these (`services/linear/converter.ts:249`) |
| `https://linear.app/{ws}/issue/{IDENT}/…` | `iss:${conn}:${IDENT}` | |
| bare `IDENT` (`ENG-123`) in PR title, body, branch name | `iss:${conn}:${IDENT}` | only for team keys seen under `linear/teams/`, so `UTF-8`, `SHA-256`, `ISO-8601` never match |
| `https://{team}.slack.com/archives/{C}/p{ts}` | `thr:${conn}:${C}:${ts}` | |
| `https://www.notion.so/{slug}-{id32}` | `doc:notion:${conn}:${id}` | |
| `…/wiki/spaces/{KEY}/pages/{id}` | `doc:confluence:${conn}:${id}` | |
| repo-relative path in backticks or `{o}/{r}:{path}` | `fil:${repoId}:${path}` | only when the path exists in that repository's indexed file list |
| `@{org}/{team}` in CODEOWNERS | `team:github:${org}/${team}` | |
| `ADR-0NN`, `docs/adr/0NN-*.md` | `dec:${repoId}:${path}` | |

Unresolved references keep `sourceUrl` on the evidence row and create no node, except the PR / Issue stubs in D3.

---

## 6. Pipeline v2

**6.1 Extractor registry keyed by warehouse prefix.** `github/pulls/` → PR extractor (exists on branch), `linear/` → Linear extractor, `slack/` → Thread extractor, `notion/` + `confluence/` → Document extractor, ADR globs → Decision extractor. Each is `parse(frontmatter, body, path) → { objects, claims }`, deterministic, unit-tested against the connector's own renderer (render → parse round-trip, as `graph.test.ts` does today). The source-connectors skill gains a rule: a connector ships its frontmatter contract and its extractor together.

**6.2 Reference resolver** (§5.4) as one module with a table-driven grammar and property tests. Extractors emit references as `{ url | identifier | path }`; resolution happens in the link pass so cross-extractor joins do not depend on ordering.

**6.3 Link pass** generalises `linkLocatedPaths`: paths → `File` + `PART_OF`; references → `REFERENCES` / `RENAMED_FROM` / `SUPERSEDES`; lexical `MENTIONS` for exact paths and package names found in Issue, Thread, Document and Decision bodies; CODEOWNERS → `OWNS` over package roots; commutation checks (P3) as assertions in tests and as a debug counter in production.

**6.4 Temporal plumbing.** `ExtractedClaim` gains optional `validFrom`, `validTo` (ISO date). `deduplicateAndStore` passes them into `CreateClaimInput` and `claimsForProjection`; projection already writes `valid_from` / `valid_to`. Change edges: `validFrom` = merged date. `File PART_OF *` validity is reconciled at source-repository ingest: a File absent from the current tree gets `validTo` from its latest `REMOVED` edge, else the ingest date; a File present again gets `validTo` cleared. Exact timestamps live in evidence `provenance.occurredAt`; widening `date` to `timestamptz` is a later migration if a consumer needs it.

**6.5 Evidence keys.** Convention `${extractor}:${repositoryId}:${…}:${targetHash}`. For claims extracted in one repository about another: `githubPull:${contextRepoId}:${sourceRepoId}:${markdownPath}:${predicate}:${filePath}:${targetHash}`. Both the `:${repositoryId}:` needle and the `(^|:)path(:|$)` regex used by `retractIngestionForDiffPg` then hit, so editing or deleting a mirrored file retracts exactly its claims, and deleting either repository purges them.

**6.6 Connector-only short-circuit.** In `repository-ingestion`, when `ingestMode === "partial"` and every changed, deleted and renamed path `isConnectorMirrorPath`, skip `extractKind`, `identify_*` and `extractInstructionUnits`; run registry extractors, link pass, dedup, retraction, projection. This removes almost all LLM cost from the PR mirror and from every Linear / Slack / Notion sync.

**6.7 Embeddings per kind.** `computeEmbeddingSearchContentForObject` embeds name + summary for everything except InstructionUnit. Add: Issue → identifier, title, labels, description excerpt; PullRequest → title, body excerpt, changed paths; Thread → channel, first message excerpt; Document → title, headings; Decision → title, status, context excerpt. Hybrid search is how the planner anchors (`anchorFrom: "hybrid"`), so this is what lets a question about "the auth refactor" land on the PR and walk to the files and the issue.

**6.8 Retrieval.** Planner schema (`getYamlSchemaForLlm`) gains a one-line description per predicate family. `graph_traversal` accepts `families` and `since`. `claim_aggregation` defaults gain `MODIFIED`, `REFERENCES`, `OWNS`. `ctx_advisor` answers cite PRs, Issues and Decisions as "why" sources using evidence `sourceUrl`.

**6.9 Promotion pass (the LLM's real job).** A per-org job clusters review comments across mirrored PRs. When the same merge-gated instruction appears in ≥3 PRs, it proposes an `InstructionUnit` whose `HAS_INSTRUCTION` claim carries one evidence row per comment (`sourceUrl` = comment URL, `provenance` = PR numbers). Proposal lands as a **pull request into `AGENTS.md`** in the owning repository, which is the site's "review in PRs / instruction hierarchy lives in your repo" line made literal, and keeps git as the approval boundary (ADR-022, ADR-025 doctrine). The same job promotes Decisions from ADR files that the deterministic parser could not classify.

---

## 7. Worked example

Linear issue `ENG-123 "Split user create out of the HTTP handler"` (team Backend, project Auth cleanup) has a GitHub attachment for `acme/api#42`. PR 42 was merged on 2026-03-02, approved by bob, and touched `src/http/createUser.ts` (modified), `src/domain/user.ts` (added), `src/legacy.ts` (removed). A Slack thread in `#eng-backend` linked the PR while arguing about it. `docs/adr/0007-domain-logic-in-services.md` is Accepted. CODEOWNERS maps `src/**` to `@acme/backend`.

Deterministic output, every triple from frontmatter, URLs, paths or CODEOWNERS:

```
iss:c1:ENG-123        PART_OF        prj:c1:auth-cleanup
team:c1:backend       OWNS           iss:c1:ENG-123
iss:c1:ENG-123        REFERENCES     prq:repo_api:42        {state: merged}
prq:repo_api:42       REFERENCES     iss:c1:ENG-123         (identifier in title / branch)
prq:repo_api:42       TARGETS        repo_api               valid_from 2026-03-02
prq:repo_api:42       MODIFIED       fil:repo_api:src/http/createUser.ts   valid_from 2026-03-02
prq:repo_api:42       ADDED          fil:repo_api:src/domain/user.ts       valid_from 2026-03-02
prq:repo_api:42       REMOVED        fil:repo_api:src/legacy.ts            valid_from 2026-03-02
fil:repo_api:src/…    PART_OF        svc:repo_api:src       (legacy.ts: valid_to 2026-03-02)
team:github:acme/backend  OWNS       svc:repo_api:src
thr:c2:C9:1709…       REFERENCES     prq:repo_api:42
dec:repo_api:docs/adr/0007-…  DECLARED_IN  fil:repo_api:docs/adr/0007-…
dec:repo_api:docs/adr/0007-…  INFLUENCES   svc:repo_api:src   (MENTIONS "src/domain")
```

Agent asks Q1, "why is user creation split across http and domain?" Hybrid search anchors on the Decision or the PR; traversal walks `Decision INFLUENCES Service`, `PullRequest MODIFIED File PART_OF Service`, `Issue REFERENCES PullRequest`, `Thread REFERENCES PullRequest`; the answer cites ADR-0007, PR 42 with bob's approval, ENG-123, and the Slack thread, each with a URL from evidence. Every hop is deterministic. The only LLM in the story is the one composing the answer.

Join density for this subgraph: the PR node has edges from GitHub, Linear and Slack; the File nodes from GitHub PR extract and source-repository extract; the Service from source extract, CODEOWNERS and the ADR. That is what "compounds" means.

---

## 8. Metrics and acceptance

Add to `KnowledgeGraphMetricsSchema` and log per ingest:

| Metric | Definition | Target direction |
|---|---|---|
| Join density | nodes with edges whose evidence comes from ≥2 source families / all nodes | up; north star |
| Cross-family edge share | edges whose endpoints are in different families / all edges | up |
| PR → Issue link rate | mirrored PRs with a `REFERENCES Issue` / mirrored PRs | measure; expect >50% where Linear is connected |
| File containment | File nodes with `PART_OF` / File nodes | ~100% for connected repos |
| Orphan rate | degree-0 nodes; degree-1 nodes whose only edge is same-family | 0; down |
| Evidence rows per claim per source | should be ~1 after the key fix | 1 |
| Dead kinds | kinds in allowed connections with no extractor | 0 |
| Freshness | webhook receipt → claim projected, p50 | minutes |

Baseline on TruRec AI and two other orgs before re-ingest; report after.

---

## 9. Migration and rollout

1. **Predicates**: rename on the branch. No customer data carries `ABOUT` for File / PR / InstructionUnit yet.
2. **Legacy instruction units from connector dumps**: one admin job retracts evidence whose key has a path segment under `(linear|notion|slack|confluence|github)/`, reusing `retractIngestionForDiffPg` logic; orphan objects are removed by the existing reconcile. Run once per org before re-ingest.
3. **Re-ingest** all connected repositories (full) once Phase 0 + 1 are deployed; then run the PR mirror backfill and Linear / Slack re-syncs so the registry extractors see every file. A manual re-index is now a full ingest that also retracts what the repository no longer asserts (ADR-033 §11, Appendix C); before that change a re-index at an unchanged tip added drifted extractions and removed nothing.
4. **Hosted GitHub App**: subscribe to `pull_request_review`, `pull_request_review_comment`, `issue_comment`; grant Issues: Read (ADR-031 consequence).
5. **Docs**: knowledge-graph overview lists kinds by family and predicates with semantics; ingestion page states the three layers (warehouse, search, graph); ADR-033 "Graph ontology v2" amends ADR-032 §2 (predicates) and §4 (connector nodes); source-connectors skill requires an extractor per connector.

---

## 10. Phasing

**Phase 0, this branch (`github-pr-mirror`)**: fix the build and the evidence keys; `PART_OF` / `DECLARED_IN` / `TARGETS`; `RENAMED_FROM`; validity plumbing with merged dates; neutral File payload; batch backfill commits; policy before snapshot fetch; idempotency keys; latest-review-per-reviewer decision; per-repo error isolation; connector-only short-circuit; drop dead kinds from planner schema; tests for extractor, sync, client, workflows; changeset; ADR-033 draft.

**Phase 1, stacked branches, same release**: reference resolver and link-pass generalisation; Linear extractor (Issue, Project, Team, `OWNS`, `REFERENCES` both directions); Slack Thread extractor; Decision extractor from ADR files with `SUPERSEDES`, `DECLARED_IN`, `INFLUENCES`; CODEOWNERS → `OWNS`; per-kind embeddings; metrics; planner predicate descriptions; legacy cleanup job.

**Phase 2**: `Document` for Notion / Confluence / Linear documents with hierarchy and `MENTIONS`; promotion pass opening `AGENTS.md` PRs; family-parameterised traversal; Incident contract with opt-in Slack incident captures.

**Phase 3 (needs its own ADR)**: outcomes captured, meaning agent-run feedback recorded as evidence on norms; opt-in `Person`; Jira, GitLab, PagerDuty connectors through the registry.

---

## 11. Decisions requested

1. **D1**: connector entities enter as typed kinds (C) with `Document` for pages (D); all in-scope Issues, all Slack captures; Notion / Confluence in Phase 2. *Recommend yes.*
2. **D2**: typed predicate families; rename `ABOUT` uses on this branch before release. *Recommend yes.*
3. **D3**: one reference resolver; stubs only for PR / Issue on connected repositories and workspaces. *Recommend yes.*
4. **D4**: validity on containment, merged date on change edges, day precision for now. *Recommend yes.*
5. **D5**: `Team` now from CODEOWNERS and Linear; `Person` opt-in later, handle-based, never Slack user ids. *Recommend yes.*
6. **D6**: LLM only for promotion, linking fallback, and embedding summaries; promotion proposes rules as PRs. *Recommend yes.*
7. **D7**: Phase 0 on this branch, Phase 1 stacked in the same release. *Recommend yes.*
8. Remove `Concept`, `Topic`, `Capability` from allowed connections and the planner schema until an extractor exists. *Recommend yes.*
9. Adopt join density as the graph health metric in place of nodes-to-edges. *Recommend yes.*
10. Confirm v1 exclusions: comments and reactions as nodes, full Slack history, commits, CI checks, diffs, per-blob Files.
11. **Full ingests are authoritative.** After a healthy full ingest, evidence this repository did not re-observe at the target commit is retracted (claims and orphaned nodes go with it); manual re-index requests a full ingest, webhook ingests stay incremental. *Recommend yes; implemented on the branch, see Appendix C.*

---

## Appendix A. Findings on the current branch (from the 2026-09-16 review)

Blockers: build fails on `string | null` at `routes/v1/github-pr-mirror.ts:140` and `:165`; evidence keys embed the hash mid-string and omit repository ids (`pull-request-mirror/graph.ts:158`, `linkLocatedPaths.ts:191`), so evidence accumulates per ingest and PR claims can never be retracted or purged (`ingestionRetraction.ts:82`); no changeset.

Should fix: one commit per PR in backfill (`sync.ts:138`) versus Linear's single batched commit; every PR webhook action enqueues a workflow and fetches the snapshot before policy (`github-pr-mirror-events.ts:89`, `sync.ts:82`); no idempotency key on the entity workflow (`github-pr-mirror-events.ts:71`); `reviewDecisionFromReviews` lets a stale CHANGES_REQUESTED beat a later APPROVED (`sync.ts:26`); backfill trusts the yaml list and one bad repository fails the mirror (`github-sync-content.ts:85`); File payload inherits PR state (`graph.ts:108`); repository deletion does not clear `prMirror` (`domain/repositoryDeletion.ts:269`); no tests for the extractor node, sync, client, workflows, route, model or push handler.

## Appendix B. Facts verified in code

- Core kinds and predicates: `retrieval/schema/core.ts`. Extension kinds and predicates: `retrieval/schema/extension.ts`. Allowed triples: `retrieval/schema/allowedConnections.ts`.
- No extractor emits `Decision`, `Incident`, `Concept`, `Topic`, `Capability` (grep over `apps/backend/src`, non-test).
- Claims carry `valid_from` / `valid_to` (`db/schema/claims.ts`); projection writes them (`graphProjection.ts:215`); traversal filters on `validAt` (`graphTraversal.ts:60`). `ExtractedClaim` has no validity fields (`graphs/codeIngestionGraph/schemas.ts:46`).
- Extension traversal whitelist: `graphTraversal.ts:12`. Planner schema is labels only: `retrieval/schema/llm-prompt.ts`.
- Embedding text per kind: `retrieval/services/retrievalObjectWrite.ts:19`. Stub merge rule: same file, line 50.
- Anchoring from hybrid results: `graphs/conversationGraph/nodes/graphRetrieval.ts:63`. Claim aggregation defaults: `graphs/conversationGraph/nodes/retrievalChannels.ts:97`.
- Linear frontmatter fields incl. `githubReferences`: `services/linear/converter.ts:319`. Slack frontmatter incl. `permalink`, `thread_ts`: `services/slack/converter.ts:256`. Notion path encodes hierarchy: `services/notion/converter.ts:28`. Linear users mirror stores display name and flags only, no email: `services/linear/content.ts:499`.
- Instruction glob and cap: `extractInstructionUnits.ts` (`**/*.{md,mdc}`, `MAX_INSTRUCTION_SOURCE_FILES = 10_000`); stub root Service: line 513.
- Root narrowing keeps `./`: `graphs/codeIngestionGraph/nodes/narrowRootsForPartialDiff.ts`.
- Retraction needle and path regex: `retrieval/services/ingestionRetraction.ts:78-96`. Logical key derivation: `retrieval/services/logicalSourceKey.ts:9`.

## Appendix C. Preview findings on TruRec AI (2026-09-17, PR #335, Railway `pr-335`)

Production baseline (`graph-quality-report`, read-only): 7 791 objects, 7 820 claims, 6 429 `InstructionUnit` of which 4 508 derived from connector Markdown, join density 0.4%. Instruction-unit evidence in production spans **586 distinct ingestion hashes**: every merge webhook re-extracted and nothing was ever retracted.

Run 1 (ontology v2 before the hygiene rule, all 15 repositories re-indexed from the UI): 2 946 objects, 4 849 claims; connector-derived units 0; 272 `Issue`, 2 `Team`, 3 `Thread`, 3 `Decision`, 185 `File`; `OWNS` 177, `PART_OF` 370, `DECLARED_IN` 1 886; no `PullRequest` and no `REFERENCES` (mirror off, unresolved references dropped); 158 orphans (95 issues whose team fetch had failed); join density 0.6%.

Run 2 (hygiene rule, reference stubs, identifier-derived teams; same repository tips): 3 085 objects, 5 103 claims, `InstructionUnit` 1 896 → 2 009. **Counts rose at unchanged tips.** Cause: `repository-ingestion` passes the last ingested commit as `fromHash`; codesearch reports `partial` whenever that commit is an ancestor of the target (the same commit included), path-based retraction is a no-op with an empty diff, and the extractors still re-run over the whole repository, so the LLM's naming drift mints new dedup keys next to the old ones. This is the same mechanism that inflated production. A plain re-index after merge would have added, not cleaned.

Fix on the branch (`0ce6e7b3`, refined in the following commit): manual re-index requests `fullReingest` (no `fromHash`, codesearch full mode); dedup touches every re-observed evidence row (`observedAt` to now, source id to the current commit); after a healthy full ingest the workflow retracts this repository's evidence observed before the index child's `indexedAt` (stamped before extraction), with orphaned claims and nodes, leaving other repositories' claims that merely mention it untouched. Degraded runs (search or SCIP index unavailable) skip the sweep. Covered by Postgres integration tests (touch, sweep at an unchanged tip, idempotency, foreign producer untouched) and workflow tests (full / partial / degraded / `fromHash`).

Run 3 (hash-keyed sweep, `0ce6e7b3`): the cutoff was the target commit hash. Fourteen of fifteen repositories were re-indexed at an unchanged tip, so their stale rows carried the same hash as the re-observed ones and nothing was swept; only the repository whose tip had moved lost its 2 143 old rows. That is why the cutoff became the run's start time.

Run 4 (time-keyed sweep, full re-ingest of all 15 repositories, finished 14:08 UTC): **1 346 objects, 1 792 claims**; join density 1.5% (production 0.4%); connector-derived units 0; `InstructionUnit` 458 from 12 source paths (root and package `README.md`, `AGENTS.md`, `CONTRIBUTING.md`, three checklist/workflow docs — nothing from nested READMEs or connector dumps); `Issue` 272, `File` 74, `Decision` 3, `Thread` 3, `Team` 2, `Skill` 1; `OWNS` 273, `PART_OF` 148, `DECLARED_IN` 448, `HAS_INSTRUCTION` 439; no `PullRequest` or `REFERENCES` because the mirror is off in the preview. Orphan rate 4.8% (65 claim-less objects: libraries, APIs, threads without resolvable references) — search-only rows, not graph nodes. Every repository's evidence now carries only observations from its final run.

Two further findings from the runs, both fixed on the branch: (1) the preview worker supervisor counted OpenWorkflow runs in the `default` namespace while previews use `preview-pr-N`, so it exited the worker three minutes after boot with runs in flight; (2) the sweep must be skipped when an extractor skipped files on LLM failure, otherwise a degraded LLM day retracts real facts.

Reading the numbers: the graph is smaller than production because production is mostly accumulation (6 429 instruction units from 340 paths, 586 ingestion hashes). Under the new rules the same repositories yield 458 units from 12 paths; the rest of the shrink is drift and connector junk. Nodes-to-edges is 1 : 1.33 and will only compound once the PR mirror (`PullRequest`, change edges, `REFERENCES Issue`) is on in production — that is where the cross-tool joins come from.
