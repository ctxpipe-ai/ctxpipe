# ADR-066: Knowledge content lives in ClickHouse; Postgres keeps the operational data

**Status:** Accepted (the CTO, 2026-11-19; the code does not implement it yet; the PoC and the evals of [ADR-069](ADR-069-knowledge-plane-evals-and-rollout.md) validate it) | **Date:** 2026-11-19 | **Tags:** knowledge, clickhouse, search, graph, storage, self-host, security

## Context

Knowledge retrieval uses two stores today:

- Postgres with pgvector holds the knowledge units and chunks. The hybrid search is one SQL statement (`knowledge-search.ts`). Its p95 was 27 s in production ([CTX-1043](https://linear.app/ctxpipe/issue/CTX-1043)).
- FalkorDB holds one graph for each org ([ADR-010](ADR-010-opencypher-graph-db-falkordb-default.md)). It crashed and stayed down for 10.5 h ([CTX-981](https://linear.app/ctxpipe/issue/CTX-981)), and it rejected a cleanup query ([CTX-1007](https://linear.app/ctxpipe/issue/CTX-1007)).

The corpus has many Workspaces. Most of them become cold after their first use. We want storage costs close to object storage, with no app-managed archive or restore. We also want one engine for hosted and self-host.

The concept document is on [CTX-996](https://linear.app/ctxpipe/issue/CTX-996) ("CTX-996 — ClickHouse knowledge storage architecture"). The design review gave this ADR and ADRs 067 to 069. These options were rejected:

- SlateDB: one more engine to run.
- OpenSearch: its snapshot lifecycle does not give transparent cold storage.
- Aurora for the full corpus: its storage costs too much for a mostly cold corpus.
- SurrealDB: its S3 storage needs the commercial edition.
- ClickHouse Cloud: we run the database inside our AWS boundary.

We deferred direct S3 adjacency objects. They can take graph load off ClickHouse at a larger scale.

## Decision

1. **ClickHouse OSS stores the knowledge content, for hosted and for self-host.** When the rollout of [ADR-069](ADR-069-knowledge-plane-evals-and-rollout.md) ends, these go away:
   - FalkorDB;
   - Neptune in the self-host CDK construct;
   - the graph client with several providers (ADR-010);
   - the Postgres knowledge tables and their `vector` and `tsvector` columns.
2. **The boundary.**
   - ClickHouse holds the content: documents, chunks and relations.
   - Postgres holds the operational data about the content. For each Workspace, that is the `knowledge_state` row of [ADR-067](ADR-067-knowledge-projection-applies-git-diff.md) decision 2: `last_sha`, the SHAs of runs that did not complete, the projection version (which includes the embedding model name), the run status and the failed count. Postgres also holds the job queue and the rollout flag.
   - Postgres holds no pointers to single documents or chunks. A tool that needs content calls ClickHouse.
3. **Three shared tables.** All Workspaces share the same tables. There is no table or partition for each Workspace. Each table sorts by `(org_id, workspace_id, …)` first.
   - `documents`: one row for each document. It holds:
     - `status`;
     - `deleted_at` and `error`;
     - `kind`, title, path, source type, source and summary;
     - `s3_key` and `mime` for an image;
     - `valid_from`, `valid_to` and `observed_at`.
   - `chunks`: the sections of a document. It holds `ordinal`, `text`, the full vector and its binary form (the search is in [ADR-068](ADR-068-knowledge-retrieval-jev-layers.md)), and a text index on `text`.
   - `relations`: `(src_doc, src_chunk, predicate, dst_doc)`, with confidence, validity, source and `observed_at`. A projection sorted by `dst_doc` gives the incoming relations.
4. **The grain.** Search finds chunks. The traversal moves between documents. A relation records the chunk that states it (`src_chunk`), so the provenance points to a section.
5. **A relation belongs to the document that states it.**
   - Its target is a document key that is resolved when it is read.
   - No stored value depends on another document, for example a degree or an in-degree.
   - Thus, a change to one file changes only the rows of that file.
6. **Images are documents** of kind `image`.
   - The bytes stay in the S3 artifacts bucket.
   - Each image has one chunk row. Its vector is the image embedding. Its text is the alt text, plus the OCR text if we use OCR.
   - The projection makes each `s3_key` from the org, the Workspace and the hash of the bytes. It never takes a key from the content.
   - Before the backend reads image bytes (for example to send them to Jev), it checks that the key starts with the org and Workspace prefix of the request. Thus a row cannot point the backend at the image of another org.
7. **Document status.** Each document is one of four:
   - `active`;
   - `deleted`, a tombstone with `deleted_at`;
   - `missing`, a placeholder for a link target that does not exist in Git;
   - `failed`, a placeholder with the error.

   Search returns only `active` documents. The traversal sees all four. Thus, a relation always has a target ([ADR-067](ADR-067-knowledge-projection-applies-git-diff.md)).

   The CTO chose stored placeholder rows (2026-11-19), not only a target key that is missing at read time. Reasons: the maintenance job finds them with one status query, Jev sees "does not exist" as a fact of the candidate, and a stored row keeps the difference between "deleted on a date" and "never existed".
8. **Changes use the lightweight SQL `UPDATE` and `DELETE`** (patch parts). They came as a beta in ClickHouse 25.7. In 26.10.6.18, the version that we pin, `system.settings` gives them the tier "Production", and the same for the text index ([CTX-1391](https://linear.app/ctxpipe/issue/CTX-1391)). We do not depend on the experimental transactions, which also are not in the cloud product.
9. **Org isolation.** `KnowledgeStore` is the only ClickHouse client. Each query session sets its org. Reads and writes need different walls, because a ClickHouse row policy filters reads only: unlike Postgres RLS `WITH CHECK`, it does not check the rows that a session inserts.
   - **Reads have two walls:**
     - every statement has `org_id` and `workspace_id` in its `WHERE` clause;
     - a row policy limits each query to the org of its session.
   - **Inserts have two walls:**
     - the `KnowledgeStore` write API takes the org and the Workspace, and sets the `org_id` and `workspace_id` columns itself, so a caller cannot put them in a row;
     - each table has `CONSTRAINT … CHECK org_id = getSetting('SQL_ctxpipe_org_id')`, so ClickHouse refuses an insert for another org (`VIOLATED_CONSTRAINT`). An async insert must wait (`wait_for_async_insert=1`): without the wait, a refused row is dropped with no error to the client.
   - **`UPDATE` and `DELETE` have one wall.** ClickHouse applies neither the row policy nor the `CHECK` constraint to them. Its docs say that a row policy is useful only for read-only users. Thus:
     - `KnowledgeStore` builds the org and Workspace predicates of each `UPDATE` and `DELETE` itself. A caller gives only the extra predicate.
     - A test proves that the API cannot build such a statement without the two predicates.
     - The backend connects as a read-only ClickHouse user, with no `INSERT`, `UPDATE` or `DELETE` grant. Only the worker, which runs the projection, has write grants.
     - `org_id` is a sort key column, so an `UPDATE` cannot move a row to another org.
   - **Tests:**
     - each read wall works with the other removed;
     - each insert wall works with the other removed;
     - one test documents the gap: a `DELETE` with no org in its `WHERE` clause changes rows of another org;
     - the mutation API always adds both predicates.
   - **Evidence:** both facts were tested on 26.10.6.18 ([CTX-1391](https://linear.app/ctxpipe/issue/CTX-1391), [CTX-1392](https://linear.app/ctxpipe/issue/CTX-1392)). The setting `SQL_ctxpipe_org_id` uses the stock prefix `SQL_`, so no server config is needed. A session with no org fails closed (`UNKNOWN_SETTING`).
   - This replaces Postgres RLS ([ADR-042](ADR-042-postgres-rls-app-role.md)) for the knowledge content.
10. **Deployment.**
    - Hosted: one private EC2 node in us-west-2. It is separate from the observability ClickHouse and has no public listener.
    - Storage: hot parts and a file cache on EBS, and cold parts on S3. Parts move to S3 by age.
    - Self-host: one ClickHouse service in Compose, on local disk. S3 tiering is optional.
    - This replaces the FalkorDB part of the stateful host of [ADR-061](ADR-061-hosted-ctxpipe-on-aws-behind-cloudflare.md) decision 9.
11. **Recovery.** ClickHouse holds only derived data. If the node is lost, we restore a ClickHouse backup or rebuild each Workspace from Git with a full hydrate. The recovery time target decides which one we use.

## Consequences

- **One engine** serves search and the graph, and it has S3 storage economics. No app code tracks which Workspaces are hot.
- **Availability:** a single node is a point of failure. S3 tiering is durability, not high availability.
- **Cold reads:** the first read of a cold Workspace pays S3 round trips, and each layer of a traversal can pay them again. The cache size decides how many active Workspaces stay fast. A 256 MiB cache thrashed on the observability node ([CTX-1067](https://linear.app/ctxpipe/issue/CTX-1067)).
- **Patch parts:** many open patch parts make reads slower until a merge, so we monitor their count.
- **One wall for `UPDATE` and `DELETE`** (decision 9): a bug in the mutation API of the worker can change rows of another org. The read-only user of the backend and the tests of the mutation API limit this risk.
- **Fact to verify** before the build depends on it: the lightweight changes work with the projection on `relations`.
- **Self-host:** self-hosters lose the choice of graph database. The CDK construct, Compose and the self-host docs change.
- **Supersedes and amends:**
  - When all orgs use ClickHouse, this ADR supersedes ADR-010.
  - It amends ADR-061 decision 9.
  - Until then, the old stack stays in use for orgs whose flag is `off` (ADR-069).
