# ADR-067: The knowledge projection applies the Git diff, with eventual consistency

**Status:** Accepted (the CTO, 2026-11-19; the code does not implement it yet) | **Date:** 2026-11-19 | **Tags:** knowledge, clickhouse, hydrate, consistency, git

## Context

The Workspace repository in Git is the source of truth. The knowledge content in ClickHouse ([ADR-066](ADR-066-knowledge-content-in-clickhouse.md)) is a projection of it.

ClickHouse has no transaction across statements or tables. The review compared two designs:

- **Row versions:** a revision number on each row, a published pointer, and a GC of old versions.
- **Current state only:** the tables hold only the current state.

We chose the second, because simplicity wins. Git keeps the history, and the goal is to search the current knowledge.

Since [CTX-1369](https://linear.app/ctxpipe/issue/CTX-1369), a hydrate writes only the delta of each commit. [ADR-046](ADR-046-workspace-revision-projection-identity.md) already says that a run moves each store from its last written state to the branch tip. Hydration is deterministic.

## Decision

1. **The tables hold the current state only.** There are no row versions, no published pointer and no GC of versions.
2. **The operational state lives in Postgres.** For each Workspace, a `knowledge_state` row holds:
   - `last_sha`, the last commit that a run applied in full;
   - the projection version;
   - the embedding model;
   - the run status;
   - the failed count.
3. **The queue.** Each commit or webhook queues a hydrate run. One run for each Workspace runs at a time. The queued runs for a Workspace merge, because each run goes to the current tip (the ADR-046 rule).
4. **The diff.** A run applies the Git diff from `last_sha` to the tip. It does a full rebuild instead, which is the same apply with every file in the diff, if:
   - the projection version in the code is different; or
   - the old commit is missing; or
   - the sources config file ([ADR-050](ADR-050-workspace-sources-config-file.md)) changed.

   The projection version is a number in our code, plus the embedding model name. It changes when the parser, the chunking or the model changes. These are changes that the Workspace diff cannot show.
5. **A changed file replaces its state.** The run deletes all rows of the document (the document, its chunks and its outgoing relations), then inserts the new rows. Delete before insert makes a retry safe.
6. **A removed file leaves a tombstone.**
   - The document row gets `status = deleted` and `deleted_at`.
   - Its chunks and outgoing relations are deleted.
   - The relations that other documents point at it stay. If the file comes back, the next run makes the row `active` again, and those relations work at once.
7. **A missing target gets a placeholder.** A relation whose target has no row gets a `missing` document. When the file appears, the run replaces the placeholder with an `active` row.
8. **Errors.**
   - An infrastructure error throws, for example ClickHouse or the embedding API is down. The run retries from the same `last_sha`. An insert waits until the data is stored, so a reported success means stored rows.
   - A content error makes a `failed` placeholder with the error and an alert, for example a file that does not parse or embed. The run continues, so that one bad file does not block the Workspace.
   - `last_sha` moves to the tip only when all of the work passes. Nothing fails silently.
9. **The maintenance job** is queued after each run.
   - It finds `deleted`, `missing` and `failed` documents.
   - It fixes the source in Git, for example a broken link or a file that does not parse. Its fixes come back through a normal run.
   - It does not remove rows. The removal of old tombstones is a later decision.
10. **Reads during a run** can see a commit that is only partly applied, for a few seconds. We accept this.
11. **Monitoring:**
    - the lag from the tip SHA to `last_sha`, for each Workspace (the main alert);
    - the failed count;
    - the time of each apply;
    - the count of open ClickHouse patch parts.
12. **Public docs** state that a missing old commit, for example after a force-push and a Git GC, starts a full rebuild.

## Consequences

- **Simple writes.** There is no version upkeep and no GC of versions, and no row is duplicated. A missed webhook does no harm, because each run starts from `last_sha`, not from the event.
- **Self-healing.** A failed run leaves some documents new and some old. The next run applies the same diff again and repairs them.
- **Eventual consistency:** a reader can briefly see a mix of two commits. A long failure shows as lag in the monitoring, not as silent drift.
- **Tombstones grow,** because nothing removes them yet.
- **A full rebuild** costs a full parse and full embeddings. A projection version change starts one for each Workspace.
- **Amends** ADR-046 for the ClickHouse projection. The queue and tip rules stay.
- **Tests** ([ADR-069](ADR-069-knowledge-plane-evals-and-rollout.md)) must prove three things:
  - applying a real history one commit at a time gives the same tables as a full rebuild at the tip;
  - a run stopped at random points and retried gives the same result;
  - the status lifecycle works.
