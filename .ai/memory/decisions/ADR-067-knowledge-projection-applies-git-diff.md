# ADR-067: The knowledge projection applies the Git diff, with eventual consistency

**Status:** Accepted (the CTO, 2026-11-19; the writer, the state and the maintenance job are built) | **Date:** 2026-11-19 (revised 2026-11-20: the projection runs as its own workflow, outside the hydrate lock; amended 2026-11-21 by [ADR-071](ADR-071-knowledge-plane-branches.md): one projection for each branch) | **Tags:** knowledge, clickhouse, hydrate, consistency, git

## Context

The Workspace repository in Git is the source of truth. The knowledge content in ClickHouse ([ADR-066](ADR-066-knowledge-content-in-clickhouse.md)) is a projection of it.

ClickHouse has no transaction across statements or tables. The review compared two designs:

- **Row versions:** a revision number on each row, a published pointer, and a GC of old versions.
- **Current state only:** the tables hold only the current state.

We chose the second, because simplicity wins. Git keeps the history, and the goal is to search the current knowledge.

Since [CTX-1369](https://linear.app/ctxpipe/issue/CTX-1369), a hydrate writes only the delta of each commit. [ADR-046](ADR-046-workspace-revision-projection-identity.md) already says that a run moves each store from its last written state to the branch tip. Hydration is deterministic.

## Decision

1. **The tables hold the current state only.** There are no row versions, no published pointer and no GC of versions.
   - **Amended by [ADR-071](ADR-071-knowledge-plane-branches.md):** the content rows are file versions that the branches share, and each branch has a tree with a tree version and a head. A run writes the tree rows of the new tip, then moves the head. A cleanup job removes the file versions and tree rows that no head can see, after a grace time.
2. **The operational state lives in Postgres.** For each Workspace, a `knowledge_state` row holds:
   - `last_sha`, the last commit that a run applied in full;
   - `attempt_shas`, the tips of the runs that started after `last_sha` and did not complete (an empty list after a run that passes);
   - the projection version (decision 4), which includes the embedding model name;
   - the run status;
   - the failed count.
   - **Amended by [ADR-071](ADR-071-knowledge-plane-branches.md):** there is one row for each (Workspace, branch). It also holds the tree version of the head and, for a branch that is not the default branch, its merge base with the default branch.
3. **The queue.** Each commit or webhook queues a hydrate run. After the hydrate releases the Workspace hydrate lock, it queues one `knowledge-projection` run. One projection run for each Workspace runs at a time, under its own lease. The queued runs for a Workspace merge, because each run goes to the current tip (the ADR-046 rule): the run reads the tip that the Workspace wants when it starts, not the SHA of its trigger.
   - The projection does not run inside the hydrate lock. Thus a ClickHouse outage or a slow embedding API does not delay the old stack ([ADR-069](ADR-069-knowledge-plane-evals-and-rollout.md) decision 9).
   - A run that finds the lease busy sleeps and tries again. A sleeping run holds no worker slot.
   - The projection run retries by itself, for about 5 minutes. When an outage is longer, the run fails, and the next hydrate of the Workspace queues a new run. Until then, the lag metric (decision 11) shows it.
   - **Amended by [ADR-071](ADR-071-knowledge-plane-branches.md):** each push to any branch queues a run for that (Workspace, branch), and the lease is for each (Workspace, branch). The tip rule is the same on each branch.
4. **The diff.** Before a run writes any row, it adds its tip to `attempt_shas`. It then applies each file that is in the Git diff from `last_sha` to any SHA of `attempt_shas`. The list includes its own tip.
   - The earlier SHAs of the list are the tips of failed runs. Their files are the files that those runs can have changed. Without them, a file that a failed run replaced and that a later commit changed back is not in the new diff, and its stale rows stay.
   - The run only adds to the list, so a crash at any point loses no SHA.
   - If the list has more than 10 SHAs, the run does a full rebuild.
   - **Amended by [ADR-071](ADR-071-knowledge-plane-branches.md):** `attempt_shas` goes. The rows of a stopped run are tree rows above the head, which no read sees. The next run deletes them, then applies the diff from the tip of the head.
   - It does a full rebuild instead if one of the conditions below is true. A full rebuild applies every file of the tree. It also reconciles: each document in ClickHouse whose file is not in the tree becomes a tombstone (decision 6). Thus a rebuild after a missing commit does not leave removed files `active`.

   The conditions for a full rebuild are:
   - the projection version in the code is different; or
   - the old commit is missing; or
   - the sources config file ([ADR-050](ADR-050-workspace-sources-config-file.md)) changed.

   The projection version is a number in our code, plus the embedding model name. It changes when the parser, the chunking or the model changes. These are changes that the Workspace diff cannot show. It also holds the version of the file converter (`ctxpipe-convert --version`: its package version and a hash of its lock file, its source, its font and the `rustc --version` of its compiler) and the prompt version of the image text ([CTX-1433](https://linear.app/ctxpipe/issue/CTX-1433)), because a new parser or prompt gives other text for the same bytes.
5. **A changed file replaces its state.** The run deletes all rows of the document (the document, its chunks and its outgoing relations), then inserts the new rows. Delete before insert makes a retry safe.
   - **The run reuses stored vectors** ([CTX-1428](https://linear.app/ctxpipe/issue/CTX-1428)). Each chunk row holds `embedding_key`: the SHA-256 of the model, the dimensions and the content that the embedding request sends (the context line and the text, or the bytes of an image). Before the run embeds the files of a batch, it reads the stored vectors of their keys, from the chunks of the same documents in the same Workspace. An input with a stored vector gets that vector. Only the other inputs go to the model, and inputs of one batch with the same key share one request. Thus a retry after a failed run, also a full rebuild, embeds only the files that the failed run did not write: each write of 1,000 files that the failed run completed gives its vectors.
   - **Why this store:** the chunk rows that the run is about to replace already hold the vectors. The lookup happens before the `DELETE` of the batch, so a parser-only rebuild finds each unchanged chunk. A separate cache table would need its own walls, grants and cleanup. The lookup goes through `KnowledgeStore`, so it has both read walls of ADR-066 decision 9, and it reads no row of another Workspace or org.
   - **What misses:** a model or a dimension change (each key changes, so the run embeds all again), a renamed file (its document key changes), a chunk whose context line changed (for example a new title or a new chunk count), the rows from before the column (an empty key), and the rows that a crashed run deleted before its `INSERT`. A miss costs only the request.
   - **The crash-safety order stays:** the lookup is a `SELECT` before the `DELETE`, and the write is the same `DELETE`, then `INSERT`. A stored vector is the `BFloat16` value, and a write of a `BFloat16` value stores the same value. Thus a run with reuse writes the same rows as a run without it, and a retry gives the same tables.
   - **Amended by [ADR-071](ADR-071-knowledge-plane-branches.md):** a changed file adds a file version (or uses the stored one with the same key) and a tree row. It deletes no rows. The vector lookup and its keys stay the same.
6. **A removed file leaves a tombstone.**
   - The document row gets `status = deleted` and `deleted_at`.
   - Its chunks and outgoing relations are deleted.
   - The relations that other documents point at it stay. If the file comes back, the next run makes the row `active` again, and those relations work at once.
   - **Amended by [ADR-071](ADR-071-knowledge-plane-branches.md):** the tombstone is a tree row of the branch. The file version stays for the other branches.
7. **A missing target gets a placeholder.** A relation whose target has no row gets a `missing` document. When the file appears, the run replaces the placeholder with an `active` row.
   - **Amended by [ADR-071](ADR-071-knowledge-plane-branches.md):** no `missing` row is stored. A relation target with no row in the view of the branch is `missing` when it is read.
8. **Errors.**
   - An infrastructure error throws, for example ClickHouse or the embedding API is down. The run retries from the same `last_sha`. An insert waits until the data is stored, so a reported success means stored rows.
   - A content error makes a `failed` placeholder with the error and an alert, for example a file that does not parse or embed, a file type with no converter, a file that the converter cannot read (encrypted, malformed, too large, no PDF text layer), or an image that the vision model refuses. The run continues, so that one bad file does not block the Workspace. An outage of the vision model is an infrastructure error, as an outage of the embedding API is.
   - A content error that the run records as a `failed` row counts as completed work. Only an infrastructure error stops `last_sha`.
   - `last_sha` moves to the tip only when all of the work passes. In the same update, the run clears `attempt_shas`. Nothing fails silently.
9. **The maintenance job** is queued after each run.
   - **Amended by [ADR-071](ADR-071-knowledge-plane-branches.md):** the job is queued only after a run of the default branch. No run of another branch starts maintenance or writes to the repository.
   - It finds `deleted`, `missing` and `failed` documents.
   - It fixes the source in Git, for example a broken link or a file that does not parse. Its fixes come back through a normal run.
   - It does not remove rows. The removal of old tombstones is a later decision.
10. **Reads during a run** can see a commit that is only partly applied, for a few seconds. We accept this.
    - **Amended by [ADR-071](ADR-071-knowledge-plane-branches.md):** a read takes the tree at the head of the branch, so it sees the old tip or the new tip, never a mix.
11. **Alerts and metrics:**
    - the lag of each Workspace (the main alert): the wall-clock time since the hydrate of the oldest tip that no completed run applied. A current Workspace has no lag. The alert measures it from the hydrate result logs and the run spans (`knowledge.projection.apply`). The writer records no lag metric. A metric that a run records has no point when no run starts. The time between two commits is not the lag either: after a quiet week it reads days while the projection is current;
    - the failed count;
    - the time of each apply;
    - the count of pending ClickHouse mutations (`system.mutations`) and the age of the oldest, because each `DELETE` is a mutation (ADR-066 decision 8). The knowledge node gives them to the host metrics agent, and an alert fires when the oldest is an hour old;
    - the count of mutations of each run (`knowledge.projection.mutations`);
    - the embedding work of each run (decision 5): the inputs with a stored vector (hits) and the inputs that go to the model (misses) (`knowledge.projection.embedding_lookups`, by `result`), the requests (`knowledge.projection.embedding_requests`), and the time in the embedding API (`knowledge.projection.embedding_duration`).
12. **Public docs** state that a missing old commit, for example after a force-push and a Git GC, starts a full rebuild.

## Consequences

- **Simple writes.** There is no version upkeep and no GC of versions, and no row is duplicated. A missed webhook does no harm, because each run starts from `last_sha`, not from the event.
- **Repair by retry.** A failed run leaves some documents new and some old. The next run applies the same files again (decision 4) and repairs them.
- **Eventual consistency:** a reader can briefly see a mix of two commits. A long failure shows as lag in the metrics, not as silent drift.
- **Tombstones grow,** because nothing removes them yet.
- **A full rebuild** costs a full parse. It embeds only the content that has no stored vector (decision 5), unless the model or the dimensions changed. A projection version change starts one for each Workspace.
- **Amends** ADR-046 for the ClickHouse projection. The queue and tip rules stay.
- **Tests** ([ADR-069](ADR-069-knowledge-plane-evals-and-rollout.md)) must prove that:
  - when a run applies a real history one commit at a time, the tables are the same as after a full rebuild at the tip;
  - a run that stops at a random point and then retries gives the same result, also when a later commit changes back a file of the failed run;
  - a full rebuild after a missing commit makes the documents of removed files tombstones;
  - the status lifecycle works.
