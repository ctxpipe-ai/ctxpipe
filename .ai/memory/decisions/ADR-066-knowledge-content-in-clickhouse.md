# ADR-066: Knowledge content lives in ClickHouse; Postgres keeps the operational data

**Status:** Accepted (the CTO, 2026-11-19; the code does not implement it yet; the PoC and the evals of [ADR-069](ADR-069-knowledge-plane-evals-and-rollout.md) validate it; amended by [ADR-071](ADR-071-knowledge-plane-branches.md): every branch is projected) | **Date:** 2026-11-19 | **Tags:** knowledge, clickhouse, search, graph, storage, self-host, security

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
   - **Amended by [ADR-071](ADR-071-knowledge-plane-branches.md):** `knowledge_state` has one row for each branch of the Workspace. The row is the head of the branch: its projected tip, its tree version and, for a branch that is not the default branch, its merge base. `attempt_shas` goes.
3. **Five shared tables.** All Workspaces share the same tables. There is no table or partition for each Workspace. Each table sorts by `(org_id, workspace_id, …)` first.
   - `documents`: one row for each document. It holds:
     - `status`;
     - `deleted_at` and `error`;
     - `kind`, title, path, source type, source and summary;
     - `mime` for an image;
     - `valid_from`, `valid_to` and `observed_at`.
   - `chunks`: the sections of a document. It holds `ordinal`, `text`, the full vector and its binary form (the search is in [ADR-068](ADR-068-knowledge-retrieval-jev-layers.md)), the key of the vector for its reuse (`embedding_key`, [ADR-067](ADR-067-knowledge-projection-applies-git-diff.md) decision 5), and a text index on `text`.
   - `relations`: `(src_doc, src_chunk, predicate, dst_doc)`, with confidence, validity, source and `observed_at`. It sorts by `src_doc`, for the outgoing relations.
   - `relations_in`: the same rows, sorted by `(org_id, workspace_id, dst_doc, predicate, src_doc)`, for the incoming relations. `KnowledgeStore` writes and deletes both tables.
   - `doc_refs`: `(org_id, workspace_id, ref_key, doc_key)`, sorted by `ref_key`. Each row is a reference key that a file states for itself (decision 5). `KnowledgeStore` writes and deletes it together with the other rows of the file. It has the same `CHECK` constraint and row policy as the other tables (decision 9). It comes with [CTX-1400](https://linear.app/ctxpipe/issue/CTX-1400).
   - Why a second table and not a projection ([CTX-1391](https://linear.app/ctxpipe/issue/CTX-1391)): one patch part anywhere in a table stops every read from using any projection of that table, until a merge removes the patch. A `DELETE` on a table with a projection also rewrites whole parts. A second table does not have these limits: with a patch part present, it read the same 29 granules as a clean projection (12 ms warm).
   - **Amended by [ADR-071](ADR-071-knowledge-plane-branches.md):** the content tables hold file versions, keyed by (org, Workspace, path, blob SHA, variant), which all branches share. A tree table, the sixth shared table, says which file version each branch holds at each path. It has the same sort key prefix, `CHECK` constraint and row policy as the other tables (decision 9). The default branch has a full tree, and each other branch has an overlay on it.
4. **The grain.** Search finds chunks. The traversal moves between documents. A relation records the chunk that states it (`src_chunk`), so the provenance points to a section.
5. **A relation belongs to the document that states it.**
   - Its target is a document key that is resolved when it is read.
   - No stored value depends on another document, for example a degree or an in-degree.
   - Thus, a change to one file changes only the rows of that file.
   - Some links name their target by a key from the front matter of another file, for example a Linear identifier or an issue URL in a mirror file. Such a link targets that reference key. Each file states its own reference keys in `doc_refs` (decision 3), and the read resolves a key target through it. A key with no row is a `missing` target ([CTX-1400](https://linear.app/ctxpipe/issue/CTX-1400)). The `CHANGED` claims of a merged pull request work the same way.
   - `relations.dst_doc` holds a key target as `ref:<key>`. A document key is a hash, so it never starts with `ref:`.
   - A key target gets no stored `missing` placeholder (decision 7). The read gives a `missing` neighbor for it. Reason: a file names no Linear team, so each identifier in capitals (also `SHA-256`) is a key. A stored placeholder for each one would fill the `documents` table.
   - A file cannot see which package roots exist. Thus a merged pull request has a `CHANGED` relation to each package whose root holds a changed file, and to its Repository. The old stack picks only the deepest root, and the Repository only for a file outside each root.
   - A Linear URL key holds the Linear workspace of the URL, so a URL of another Linear workspace does not resolve. A Confluence URL key holds only the page id, because a mirror file does not name its site.
   - The `source_type` of a document is its source authority kind (`adr`, `merged-pr`, `docs`, `issue`, `open-pr`, `chat` or `other`), which the mapper takes from the file alone: its path, its kind and its own front matter. [ADR-068](ADR-068-knowledge-retrieval-jev-layers.md) decision 4 ranks it ([CTX-1410](https://linear.app/ctxpipe/issue/CTX-1410)).
   - **Amended for issue mentions** (decided by the lead, 2026-11-22, [CTX-1502](https://linear.app/ctxpipe/issue/CTX-1502)). An issue relates to the code knowledge that it names through reference keys, with the predicate `MENTIONS`:
     - A knowledge unit of a code kind (Service, App, Library, API, Operation, Database, Infrastructure, Repository) states the key of its name (`name:<name>`), and an Operation also states `op:<METHOD> <path>` and `oppath:<path>`. A package unit and a Repository already state their `CHANGED` keys of decision 5.
     - An issue states a `MENTIONS` link to each key that its text names, with the confidence of the rule that found it: a file path names each package root below the repository top that can hold it, in the repository of each `sources` entry of the issue, and a GitHub permalink of a file names them in its own repository (0.9), a method and an HTTP path (0.9), an HTTP path without a method (0.8), a label `area/<name>` or `component/<name>` (0.8), a code span (0.8), and a name with `-` or `_` (0.7). A plain word is not a mention, also the first word of a title before a colon (`Bug: …`). The rules use only the issue file, and no model.
     - A file cannot see which names exist, so most `MENTIONS` keys name no document. Such a link is not a relation: the read gives no `missing` neighbor for it, and the maintenance job does not count it. Reason: an issue states about 25 such keys, so Jev would see about 25 `missing` neighbors for each issue, and the maintenance job would report each one as a broken link.
     - The read weighs each resolved mention by the specificity of its key: the confidence of the rule, times an inverse document frequency over the files of the view that mention the key, divided by the count of documents that state the key, because a name of two units does not say which one the issue means. Thus a key that names the whole project (the name `kubernetes` in a Kubernetes corpus) gives a low confidence. The weight is calculated at read time, because a stored value cannot depend on another document.
   - **Amended by [ADR-071](ADR-071-knowledge-plane-branches.md):** the rows of a file depend only on the file and its variant. The variant is a hash of the projection version and, for a Markdown file, of the source repositories of the tree. The `valid_from` that comes from the introducing commit goes on the tree row, because it depends on the branch. The source's own time of a file (for example the `createdAt` of a mirrored issue, or the date of a design record) depends only on the file, so it is on the file version (`documents.valid_from`), and the tree row takes it first ([CTX-1516](https://linear.app/ctxpipe/issue/CTX-1516), ADR-071 decision 2).
6. **An image is a Git file like any other**, of kind `image`.
   - Its key is its path. A changed image file replaces its rows, and a removed image file becomes a tombstone, the same as any file.
   - A file that shows an image states only an `EMBEDS_IMAGE` relation to the image's path, with the alt text on the relation. If the image has no row, the target is a `missing` placeholder. Thus the rows of a file do not depend on the bytes of an image (decision 5).
   - The bytes stay only in the Workspace Git. There is no copy in object storage and no store setting (the CTO, 2026-11-19). The `s3_key` column is dropped ([CTX-1412](https://linear.app/ctxpipe/issue/CTX-1412)).
     - The backend reads no image bytes at retrieval, and Jev sees none ([ADR-068](ADR-068-knowledge-retrieval-jev-layers.md) decision 6; [CTX-1432](https://linear.app/ctxpipe/issue/CTX-1432)). Codesearch has no route that reads a blob at a commit.
   - **Files become text at projection time** ([CTX-1433](https://linear.app/ctxpipe/issue/CTX-1433); the CTO, 2026-11-20). The writer reads each file at the tip, converts it to text in memory, and chunks and embeds that text. No derived text goes into the Workspace Git: "we don't want to store that in git because that would duplicate the data and introduce whole range of inconsistency issues. We should make the process as deterministic as possible (this applies to images as well)." This replaces the earlier plan that ingest writes a text file beside each image.
     - **Documents:** the converter (`apps/backend/converter`, `ctxpipe-convert`) takes the top file types only: "Good support speed for the top file types is more important than exotic file types" (the CTO). PDF (the text layer only) goes through pdf-inspector, DOCX, PPTX and XLSX through anydoc, and HTML through htmd. All are Rust with permissive licenses and exact version pins. The version of the converter holds a hash of its lock file, its source, its font and the `rustc --version` of its compiler, and it is part of the projection version ([ADR-067](ADR-067-knowledge-projection-applies-git-diff.md) decision 4). pdfium is the named fallback for PDF if pdf-inspector fails us: it is more mature but gives no Markdown structure. A file with no converter, or a file that the converter cannot read, gets a `failed` document with the reason ([ADR-067](ADR-067-knowledge-projection-applies-git-diff.md) decision 8).
     - **Isolation:** the parsers read untrusted bytes, so the converter is a separate process with its own address-space and CPU limits, a wall-clock limit, and caps on the input (48 MiB in the writer), the text (16 MiB) and the PDF pages (2,000). It gets no environment, and in the worker (root) it runs as the user `nobody`, so it cannot read the files or the environment of the worker. On Linux, after it reads its input, it installs a seccomp allowlist: only the calls that the parsers need work (memory, threads, time, the signals of this process, random bytes, and the read and write of stdin and stdout). Each other call fails: a file, a change of a path, a socket, a program, a process (a thread still starts), shared memory, a message queue, or another process. A trace of the conversion of each test file gave the list. Thus a parser bug cannot send data out, read a key, or leave a process, a file or shared memory behind. On a developer host (macOS) only the limits and the user apply.
     - **Images:** a ZDR vision model reads the image ([ADR-068](ADR-068-knowledge-retrieval-jev-layers.md) decision 6): "Vision model, cached by blob hash" (the CTO). An SVG is first drawn to a PNG by the converter (resvg, with one embedded font), and its text labels are added to the text. The image document gets the chunks of that text.
     - **The cache:** the table `image_texts` keeps each reading by (org, Workspace, blob SHA, the vision model of the request (`MODEL_VISION_NAME`), the prompt version), with the walls of decision 9. A rebuild reads the cache and makes no vision call, so the same bytes give the same text. If the cache is lost, a rebuild calls the model again and can get other text: the cache is what makes the image text repeatable.
7. **Document status.** Each document is one of four:
   - `active`;
   - `deleted`, a tombstone with `deleted_at`;
   - `missing`, a placeholder for a link target that does not exist in Git;
   - `failed`, a placeholder with the error.

   Search returns only `active` documents. The traversal sees all four. Thus, a relation always has a target ([ADR-067](ADR-067-knowledge-projection-applies-git-diff.md)).

   The CTO chose stored placeholder rows (2026-11-19), not only a target key that is missing at read time. Reasons: the maintenance job finds them with one status query, Jev sees "does not exist" as a fact of the candidate, and a stored row keeps the difference between "deleted on a date" and "never existed".

   **Amended by [ADR-071](ADR-071-knowledge-plane-branches.md) decision 5:** a `missing` target is calculated when it is read, and it is not stored. A stored placeholder in the overlay of a branch would hide a file that the default branch adds later. A tombstone is a tree row, so it keeps the difference between "deleted on a date" and "never existed". The traversal still gives a `missing` neighbor to Jev. A `failed` document is a `failed` file version.
8. **Each change is a `DELETE`, then an `INSERT`.** The `DELETE` is the classic lightweight `DELETE` (the `_row_exists` mask), and it is synchronous. There is no `UPDATE`: a tombstone reads the document row, deletes it, and inserts it again with `status = deleted` and `deleted_at`. We pin ClickHouse 26.10.6.18. The text index became generally available (GA) in 26.2 ([CTX-1391](https://linear.app/ctxpipe/issue/CTX-1391)). We do not depend on the experimental transactions, which also are not in the cloud product.
   - **Why not patch parts** ([CTX-1401](https://linear.app/ctxpipe/issue/CTX-1401)). A `DELETE` with `lightweight_delete_mode = 'lightweight_update'` and the lightweight `UPDATE` write patch parts. On 26.10.6.18, reads can miss them. We ran 100 rounds of insert, change and read, with background merges only:
     - a `DELETE` in a patch part: 35 reads still returned the deleted row;
     - a lightweight `UPDATE`: 39 reads still returned the old value;
     - the classic `DELETE`: 0 stale reads, in the same time (about 140 ms for the change and the read).
   - **The trigger:** the changed rows are in a part that a merge made, and the read moves a filter to `PREWHERE` (the default). The stale row stays until a later merge. In one test, it stayed for more than 45 s with no writes. A review comment on ClickHouse PR [#112947](https://github.com/ClickHouse/ClickHouse/pull/112947) describes this gap. A contract test reproduces it, and it fails when a ClickHouse version fixes the gap.
   - **The cost:** each `DELETE` is a mutation. It rewrites the `_row_exists` mask of each part that it touches, also of parts on S3. The mutations of one table run in order, so many small `DELETE`s form a queue. Thus `KnowledgeStore` deletes in batches: one write deletes the rows of all its keys with one `DELETE` for each table, with an `IN` list of at most 1,000 keys in a query parameter. The `DELETE`s of `relations_in` and `doc_refs` also filter by the link targets and the reference keys of those keys (their sort keys), and take one more `DELETE` for each more 1,000 of them. The writer makes one write for each group of 1,000 changed files ([CTX-1413](https://linear.app/ctxpipe/issue/CTX-1413)).
   - Only patch parts need the block number and block offset columns, so the tables do not make them.
   - **Amended by [ADR-071](ADR-071-knowledge-plane-branches.md):** a file version and a tree row are written one time, with an `INSERT` only. The cleanup job and the deletion of a branch make the `DELETE`s, in batches, with the same rules.
9. **Org isolation.** `KnowledgeStore` is the only ClickHouse client. Each query session sets its org. Reads and writes need different walls, because a ClickHouse row policy filters reads only: unlike Postgres RLS `WITH CHECK`, it does not check the rows that a session inserts.
   - **Reads have two walls:**
     - every statement has `org_id` and `workspace_id` in its `WHERE` clause;
     - a row policy limits each query to the org of its session.
   - **Inserts have two walls:**
     - the `KnowledgeStore` write API takes the org and the Workspace, and sets the `org_id` and `workspace_id` columns itself, so a caller cannot put them in a row;
     - each table has `CONSTRAINT … CHECK org_id = getSetting('SQL_ctxpipe_org_id')`, so ClickHouse refuses an insert for another org (`VIOLATED_CONSTRAINT`). An async insert must wait (`wait_for_async_insert=1`): without the wait, a refused row is dropped with no error to the client.
   - **A `DELETE` has one wall.** ClickHouse applies neither the row policy nor the `CHECK` constraint to a `DELETE` or an `UPDATE`. Its docs say that a row policy is useful only for read-only users. Thus:
     - `KnowledgeStore` builds the org and Workspace predicates of each `DELETE` itself. A caller gives only document keys.
     - A test proves that the API cannot build a `DELETE` without the two predicates.
     - **Amended for the deletion of an org or a Workspace** ([CTX-1642](https://linear.app/ctxpipe/issue/CTX-1642)): the purge of a deleted org has only the org predicate, because it deletes the rows of each Workspace of the org. The purge of a deleted Workspace has both predicates. The purge makes one `DELETE` for each knowledge table, and it is the only `DELETE` without a Workspace predicate. The worker runs it (`knowledge-purge`) after no projection run of the org or the Workspace is running.
     - **Deleted bytes** ([CTX-1672](https://linear.app/ctxpipe/issue/CTX-1672)): a `DELETE` only hides a row. The part keeps the bytes of the row until a merge rewrites the part, and a cold part does not often merge. Thus the purge run erases after the `DELETE`s:
       - It finds each partition of each table that holds rows of the scope, with `apply_deleted_mask = 0`. For each such partition, it sends `ALTER TABLE … APPLY DELETED MASK IN PARTITION ID …`.
       - This mutation removes only the rows that a `DELETE` hid, so it cannot remove a visible row. The `ALTER DELETE` grant of the writer is enough for it.
       - The run counts the rows of the scope in the parts each 10 minutes until the count is zero. Each hour, it sends the erase again, in case an operator killed a mutation.
       - ClickHouse removes each replaced part `old_parts_lifetime` (8 minutes) after the mutation, when no query reads it. On the cold volume, it removes the objects of the part from the bucket. The bucket has no versioning. The writer cannot read `system.parts`, so the run waits 10 minutes more and then logs `erased`. A contract test proves that the replaced parts go.
     - **How long deleted bytes can stay:** usually less than 20 minutes after the `DELETE`s. ClickHouse stores each mutation on disk and retries it until it is done, also after a restart, so a mutation that ClickHouse accepted needs no operator. While ClickHouse fails, the purge step and the erase step each retry for about one day. If the erase step fails, or the parts still hold rows of the scope one day after the erase, the run fails and the failure shows in the workflow log. Only in that case do the bytes stay until an operator queues the purge again.
     - **Cost on the cold tier:** a mutation writes the new part to the disk of the old part, so a cold part stays cold. ClickHouse reads the part from the bucket and writes it again. These are GET and PUT requests in the same region, with no transfer fee. A month partition of 1 million chunks is about 3 GB, so the requests of one rewrite cost less than one cent at S3 Standard rates. The real cost is time, and reads through the file cache. The partition scope keeps the cost low: ClickHouse does not rewrite a part of a month with no rows of the scope, and it only renames a part with no hidden row.
     - The migrations make two users. The backend connects as `ctxpipe_reader`, with `SELECT` only. The worker, which runs the projection, connects as `ctxpipe_writer`, with `SELECT`, `INSERT` and `ALTER DELETE` on the knowledge tables. It has no `ALTER UPDATE` grant. Neither user can manage access, so neither can drop a row policy or a constraint. Only the migrations have the admin user.
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
    - Age: each table has the column `written_at` (the server sets it on INSERT), a partition for each month of it, and `TTL written_at + INTERVAL 30 DAY TO VOLUME 'cold'` ([CTX-1417](https://linear.app/ctxpipe/issue/CTX-1417)). Without the partitions, a merge puts old and new rows into one part, and that part never moves. The 30 days come from the hot volume: about 60 GB of hot parts on the 100 GB EBS volume, which is about 20 million chunks. Migration `0007_cold_parts_by_age.sql` gives the calculation.
    - Self-host: one ClickHouse service in Compose, on local disk. The same storage policy has a `cold` volume on the local disk (`clickhouse-storage.xml`), so the TTL statement works. S3 tiering is optional.
    - This replaces the FalkorDB part of the stateful host of [ADR-061](ADR-061-hosted-ctxpipe-on-aws-behind-cloudflare.md) decision 9.
11. **Recovery.** ClickHouse holds only derived data. If the node is lost, we restore a ClickHouse backup or rebuild each Workspace from Git with a full hydrate. The recovery time target decides which one we use.

## Consequences

- **One engine** serves search and the graph, and it has S3 storage economics. No app code tracks which Workspaces are hot.
- **Availability:** a single node is a point of failure. S3 tiering is durability, not high availability.
- **Cold reads:** the first read of a cold Workspace pays S3 round trips, and each layer of a traversal can pay them again. The cache size decides how many active Workspaces stay fast. A 256 MiB cache thrashed on the observability node ([CTX-1067](https://linear.app/ctxpipe/issue/CTX-1067)).
- **Mutation queue:** we monitor the count of pending mutations (`system.mutations`).
- **One wall for `DELETE`** (decision 9): a bug in the mutation API of the worker can delete rows of another org. The read-only user of the backend and the tests of the mutation API limit this risk.
- **Two tables for one relation:** `KnowledgeStore` must write and delete `relations` and `relations_in` together. A failed run can leave them different until the retry of [ADR-067](ADR-067-knowledge-projection-applies-git-diff.md) repairs them.
- **Self-host:** self-hosters lose the choice of graph database. The CDK construct, Compose and the self-host docs change.
- **Supersedes and amends:**
  - When all orgs use ClickHouse, this ADR supersedes ADR-010.
  - It amends ADR-061 decision 9.
  - Until then, the old stack stays in use for orgs whose flag is `off` (ADR-069).
