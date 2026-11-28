# ADR-071: The knowledge plane projects every branch: shared file versions, a full tree for the default branch, an overlay for each other branch

**Status:** Accepted (the CTO, 2026-11-21; [CTX-1457](https://linear.app/ctxpipe/issue/CTX-1457): built: the file versions, the trees and heads of all branches, the overlays, branch runs from GitHub pushes, the MCP `branch` argument, branch deletion and the cleanup, and the base branch selector of the chat; amended 2026-11-22 by [CTX-1516](https://linear.app/ctxpipe/issue/CTX-1516): the source time of a file; 2026-11-23 by [CTX-1526](https://linear.app/ctxpipe/issue/CTX-1526): the status dates of a Linear issue; 2026-11-26 by [CTX-1697](https://linear.app/ctxpipe/issue/CTX-1697): one copy of paths that differ only in case) | **Date:** 2026-11-21 | **Tags:** knowledge, clickhouse, branches, git, mcp, consistency

## Context

The knowledge plane ([ADR-066](ADR-066-knowledge-content-in-clickhouse.md), [ADR-067](ADR-067-knowledge-projection-applies-git-diff.md)) holds one projection for each Workspace: the tip of the default branch. An agent that changes a Workspace on a branch (the web chat sandbox, or a client agent through MCP) cannot search or walk the graph of its own changes.

The CTO (2026-11-21): "could we add lightweight branch support to the datastructure in CH? It could enable bunch of stuff that are too messy now." The CTO then decided these points:

- "by branch we mean a branch of workspace repo, for chat agent sandbox which may hold uncommited changes we can prompt it to commit first to apply changes to graph."
- Visibility: "everyone in the workspace. And we should even expose it on the MCP tools as an optional option. Because with that we can claim full branch support"
- "only on commit, stay true to principle that projection is tip of branch"
- "the mcp tools, UI and such are always querying against one branch. And because we just follow commits there's no conflict resolution to worry about."
- "we want to hydrate every commit on every branch in the workspace repo."
- The projection of a branch "does include embedding and image description. All LLM calls should be cached by the file hash so when it lands on default branch it will be cache hit not incuring new cost. It should not trigger maintenance or any process that modifies the files back."
- A burst of commits projects only the newest tip: "yes".
- A branch column, not separate tables for each branch: "we can easily introduce the column now because we're still building stuff and rebuilding main tables isn't issue whatsoever", and "we can query multiple branches at once and consistency feels better".

The review of the draft (the CTO, 2026-11-21):

- No maintenance and no write-back on a branch (decision 9): "is for now, we may decide to add it later".
- The default branch (decision 11): "yes default branch is branch as others, except during read when other branches apply the overlay".
- A limit on the count of branches: "No limit now".
- A rename of the default branch: "yes follow the setting, make sure you test for this scenario".
- The tree of a branch that is not the default branch: "B. overlay - full tree would be too large/expensive on large repos". The rejected option was a full tree of each branch tip.

One fact makes branches cheap: the rows of a file depend only on that file (ADR-066 decision 5, [CTX-1400](https://linear.app/ctxpipe/issue/CTX-1400)). Thus two branches that hold the same file at the same path need the same rows.

## Decision

1. **A branch is a branch of the Workspace repository.** The plane projects the tip of each branch. It projects only commits. The chat agent commits its changes before it asks the graph about them (a prompt rule of the chat agent).

2. **File versions are shared by all branches.**
   - A **file version** is the rows of the content of one file: its document row, its chunks with their vectors, its outgoing relations (in `relations` and `relations_in`) and its reference keys (`doc_refs`).
   - Its key is (org, Workspace, path, blob SHA, variant). The path is part of the key, because a relative link resolves against the path of its file.
   - The variant adds to the key of the CTO's decision, which is (org, Workspace, path, blob SHA). Reason: some inputs of the rows are not in the file. The variant is a hash of these inputs:
     - the projection version (ADR-067 decision 4);
     - for a Markdown file, the source repositories of the tree. The `CHANGED` keys of a package file come from them (ADR-066 decision 5).
   - A file version never changes after its write. A new projection version gives new variants, so a rebuild writes new file versions beside the old ones, and the cleanup (decision 10) removes the old ones.
   - The branches of a Workspace share the file versions. A file version never crosses the org and Workspace walls of ADR-066 decision 9.
   - A file version holds no value that depends on a branch. The `valid_from` of a document is the time of the commit that introduced the file on the branch (ADR-067), so it goes on the tree row (decision 3). A relation whose `valid_from` comes from that commit (a claim with no time of its own) records this with a flag, and the read takes the time from the tree row.
   - **Amended for the source time** (decided by the lead, 2026-11-22, [CTX-1516](https://linear.app/ctxpipe/issue/CTX-1516)). The `valid_from` of a document is the source's own time when the file states one, else the time of the introducing commit. A snapshot context repo has one commit, so the commit time is the ingest date, and a time question about an earlier date (`validAt`) found nothing.
     - The source time comes from the file alone: the `createdAt` of a connector mirror file (GitHub issues and pull requests, Linear) or its `created_at` (Plain, PagerDuty, Buildkite), the `thread_ts` of a Slack thread, and the front matter `date` or the `**Date:**` line of a design record (kind `Decision`, or an `ADR-<n>` file name). The `decisions` ingest skill writes that line from the date of the KEP, the RFC, the PEP or the ADR. A Notion or Confluence mirror file gives no creation time.
     - The source time depends only on the file, so it is on the file version: the column `documents.valid_from` (ClickHouse migration 0012). The tree row takes `documents.valid_from`, else the time of the introducing commit. Thus a claim with no time of its own also takes the source time, and the read does not change. A run that uses a stored file version reads the source time from it and does not parse the file again.
     - A link of a GitHub issue to a pull request that closed it (`closedBy`) is valid from `closedAt`. A closed issue gets no `valid_to`: it stays true history. Only the date of a design record counts. Its status dates (an accept, a supersede) come later, with [CTX-1529](https://linear.app/ctxpipe/issue/CTX-1529), after the main eval hill-climb (the CTO, 2026-11-22). A Linear issue links to each merged GitHub pull request of its `githubReferences` from its `completedAt`, else its `canceledAt`. The Linear mirror writes these two dates in the front matter ([CTX-1526](https://linear.app/ctxpipe/issue/CTX-1526)).
     - The old stack takes the same time before the commit time for each claim (`effectiveValidFrom`), also in the `valid_from` that its persist job writes into the claims in Git, and for the link to a closing pull request. Its search has no document validity: a unit with no dated claim matches each `validAt`, as before.
   - **Amended for the document times** (the CTO, 2026-11-26, [CTX-1710](https://linear.app/ctxpipe/issue/CTX-1710)). This replaces the `valid_from` of a document above. A document has no valid window. It has three times, and the tool outputs of [ADR-051](ADR-051-mcp-read-surface.md) show each of them:
     - `createdAt`: when the item began in its source. `updatedAt`: when its content last changed in its source. `expiresAt`: a hint from the author that the content is stale after this time. An expired document is still found.
     - The file keeps the property names of its source. One helper (`documentTimes`) reads them, with no case and no `_` in the compare: `createdAt` or `created_at`, `createdTime`, the `threadTs` of a Slack thread, the `date` of a design record; `updatedAt`, `lastEditedTime`, `finishedAt`, the `latest` ts of a Slack thread; `expiresAt`. Thus an old file, and a file that an outside agent edits, gives its times. ctxpipe writes no time into a file: the hydrate write job `valid_from_persist` is retired, and admission ends an old job of that kind.
     - The times that a file states depend only on the file, so they are on the file version (`documents.created_at`, `updated_at`, `expires_at`). The tree row adds the Git times of the path on its branch (`withGitTimes`): `createdAt` is the time of the file, else the commit that introduced the path. `updatedAt` of a connector mirror is the time of the file, else its `createdAt`, never a commit time, because a change of the mirror format rewrites each mirror file. `updatedAt` of an authored file is the last commit that changed the path, else its `createdAt`. A mirror with no source time (a Confluence page, a Linear label) thus has the time of the first commit that held it, for both times.
     - The Git walk gives the last commit of each path too, for each document path, not only the Markdown files. A merge counts as the change that it brings to the branch (its diff from the first parent), so a conflict resolution has the time of the merge. A delta also writes each path that a commit added or changed on one side only of the fork between the tip and `last_sha`, so that a change that a later commit reverts gives the times of a full rebuild.
     - `updatedAfter` filters on `trees.updated_at`, before the cut of the search. The projection version 12 rebuilds each Workspace.
     - A claim with no time of its own holds from the `createdAt` of its document, as before.
   - A file that does not parse, convert or embed gives a `failed` file version with the error. The error depends only on the content, so it is shared too.

3. **Each branch has a tree.**
   - A **tree row** says which file version a branch holds at a path: (org, Workspace, branch, path) → (blob SHA, variant), or a tombstone with `deleted_at`. It also holds the values that depend on the branch, for example `valid_from` (the source time of the file version, else the time of the introducing commit, decision 2).
   - **The default branch has a full tree:** one row for each document path of its tip, and a tombstone for each path that it removed.
   - **Each other branch has an overlay** (the CTO: "B. overlay - full tree would be too large/expensive on large repos"). The overlay of branch B holds only the paths whose file version at the tip of B is different from the file version at the merge base of B and the default branch. A changed or added path gets its file version. A deleted path gets a tombstone.
   - The overlay comes from the Git diff from the merge base to the tip. Thus it changes only when B gets a commit, or when a merge of the default branch into B moves the merge base. A move of the default branch does not change the overlay of B.
   - A path can leave the overlay: B changes a file back to its version at the merge base, or a merge of the default branch makes the path the same as at the new merge base. Then the run writes an **inherit** row for the path. An inherit row removes the path from the overlay, so the view of B takes the row of the default branch again. A tombstone is different: it removes the path from the view of B.
   - The tree table is a sixth shared table. It has the sort key prefix `(org_id, workspace_id, …)`, the `CHECK` constraint and the row policy of ADR-066 decision 9. The writer user inserts and deletes its rows, and the reader user only reads them. `KnowledgeStore` adds the org and Workspace predicates to each `DELETE` of it, also the `DELETE`s of the branch deletion and of the cleanup job. A read joins a tree row to its file version on the org, the Workspace, the path, the blob SHA and the variant: the same path and blob can exist in two orgs.

4. **A run never shows a half-written tree.**
   - Each branch has one **head**: its row of the Postgres table `knowledge_branch_heads` (org, Workspace, branch), with the projected tip, the tree version and, for an overlay, the default branch that it was made on. The reader and the writer use only this table, also for the default branch.
   - `knowledge_state` (ADR-067 decision 2) stays only as the view of the default branch for the previous release: the writer updates it in the same transaction as the head of the default branch. ADR-053 lets a minor release only add, so its key cannot change to (Workspace, branch). The next major release retires it, together with its unused column `attempt_shas`.
   - A run writes the tree rows of the changed paths only, with the next tree version. Then it moves the head to that version in one Postgres update.
   - A read takes, for each path, the newest tree row with a tree version that is not more than the head. Thus a reader sees the tree of the old tip or of the new tip, never a mix.
   - A run that stops leaves tree rows above the head. A read does not see them. The next run of the branch first deletes the tree rows of the branch above the head (one `DELETE`). Then it applies the diff from the tip of the head to its own tip. The file versions of the stopped run stay: they never change, so the next run can use them, and the cleanup removes those that no tree uses.
   - Thus the tree versions own the recovery from a stopped run. `attempt_shas` and the full rebuild after more than 10 attempts go (this amends ADR-067 decision 4).

5. **The read rule.**
   - The view of the default branch is its tree.
   - The view of branch B is the view of the default branch, minus each path of the overlay of B, plus the overlay rows of B. A tombstone of the overlay removes the path from the view of B.
   - **Consequence:** the view of B shows the newer files of the default branch beside the changes of B. For a path that both branches changed, the version of B wins.
   - Search finds only the active file versions of the view. A path that the view removes gives no chunk and no outgoing relation: the file version of the default branch at that path stays out of the view of B.
   - A tombstone of an overlay is the same as a tombstone of the default branch: a relation into its path gives a `deleted` neighbor.
   - **A `missing` target is calculated when it is read, and it is not stored** (this amends ADR-066 decision 7). A relation target with no row in the view is `missing`, as a reference key with no document is today (ADR-066 decision 5). Reason: a stored placeholder in an overlay would hide a file that the default branch adds later. A tombstone still keeps the difference between "deleted on a date" and "never existed", and the traversal still gives a `missing` neighbor to Jev.
   - **Amended for issue mentions** (decided by the lead, 2026-11-22, [CTX-1502](https://linear.app/ctxpipe/issue/CTX-1502)): a `MENTIONS` key with no document is not a relation, and the traversal gives no `missing` neighbor for it. An issue states about 25 candidate keys, and most of them name no unit (ADR-066 decision 5).
   - **Amended for Linear ids** ([CTX-1716](https://linear.app/ctxpipe/issue/CTX-1716)): a Linear id key (`ent:linear:<id>`) with no document is not a relation either, and the traversal gives no `missing` neighbor for it. A mirror with a project scope does not write the team and the labels of its issues (ADR-066 decision 5).

   - **Amended for case duplicates** (the CTO's principle, 2026-11-26, [CTX-1697](https://linear.app/ctxpipe/issue/CTX-1697): "we don't control all write paths. User can do direct commits to the repo without us being in loop. And we don't want to break the principle of state being projection."). Git can hold two paths that are equal after case folding (NFC, then lowercase), for example `services/Billing.md` and `services/billing.md`. On a checkout that ignores case (macOS, Windows), they are one file. A person or an outside agent can commit both, so no check on the write paths of ctxpipe can prevent them. Thus the read is correct for any tree:
     - The tree keeps both paths, as Git has them: each path keeps its document key, its file version and its tree row.
     - The view shows one row for each folded path, in this order: a file before a tombstone; then the copy that changed last, by `updated_at` (a row with no time comes last); then the canonical path (equal to its folded form); then the first path in byte order.
     - The order uses `updated_at` of each tree row (CTX-1710): the time that the file states, else, for an authored file, the last commit of the branch that changed the path, with a merge as the change that it brings to the branch. No other time column exists for the fold. Projection version 13 makes the next run of each Workspace a full rebuild, which writes the case duplicate counts of its head.
     - A relation to a hidden copy goes to the copy that the view shows, and a document does not relate to its own hidden copy. A read of a hidden copy (a seed, a document read) reads the copy that the view shows.
     - The fold sorts the whole view: about 25 ms more on 100k paths, against about 3 ms when it is off. Thus a read of a default branch folds only when its head can hold a case duplicate. The head holds `case_duplicate_rows`: the count of the tree rows (files and tombstones) after the first row of their folded path. A tombstone counts, because a link can still name its path after a repair removes one copy. A head of an earlier release has no count, so its read folds. The view of an overlay always folds: it holds the newer files of the default branch beside the rows of the branch, so the count of one tree does not show its case duplicates.
     - Each run logs the count of the case duplicates of its tip (`caseDuplicates`, no paths): the files of each type after the first of their folded path, which a repair can remove. The head also stores this count (`case_duplicates`). It is not `case_duplicate_rows`, which also counts the tombstones and thus stays above 0 after a repair.
     - **Detection.** The hourly tip check reads `case_duplicates` of the head of the default branch. When the head is at the tip that the Workspace wants and the count is above 0, the check logs the count (no paths) and queues the repair, one time for each tip. The detection uses only the knowledge plane: an org with the plane flag `off` gets no repair.
     - **The repair** (the CTO, 2026-11-26: in scope) is a normal commit that the projection reads as any other. The reads are correct without it. It keeps the canonical path, the folded path:
       - Copies with the same content, and copies of files that ctxpipe owns (a connector mirror, or a file with `generated_by`): one direct commit through the write broker (write job `case_repair`). The text of the copy that the reads show goes to the canonical path, and the other copies go. The repair finds that copy by the order of the view. It takes the `updated_at` of each copy by the same rule (`documentTimes` and `withGitTimes`), from its own walk of the Git history of the tree: it needs no projection.
       - Two copies that differ and that people or agents edited: a pull request (branch `ctxpipe/case-duplicates-<sha>`) with a semantic merge of the copies into the canonical path, by the merge model of the write workflow, with the origin `agent`: people or agents wrote both copies, so the merged file keeps only the ownership fields of the copy that the reads show (CTX-722). A person decides. While a pull request of the repair is open, no second one opens. One run makes at most 20 model calls (one for each copy after the first of a file). It takes the files in order and stops at the first file that does not fit; the files after it wait for the next pull request, and the pull request and the log give their count. The run plans on the tip that the Workspace wants when it runs. It checks that the Workspace admits that revision and is writable before it gets the write token, and again just before the push of its branch. When GitHub refuses the token or the push, the run ends as refused.
       - A copy on a host-only path, two binary copies that differ, or a file with more copies than one run can merge get no repair: a person fixes them.
     - **File reads and seeds** use the same rule: `read_file` of a hidden copy reads the copy that the view shows, `list_files` lists one path, and a `get_related` seed of a hidden copy is the copy that the view shows.

6. **Reads take one branch.**
   - `search_knowledge`, `get_related`, `read_file`, `list_files` and the UI read one branch.
   - Each MCP tool gets an optional `branch` argument. Its default is the default branch of the Workspace.
   - Each actor that can read the Workspace can read each branch, also the session branch of a conversation (`ctxpipe/chat/<conversation>/<n>`, [ADR-048](ADR-048-native-postgres-sandbox-ownership.md)). The CTO (2026-11-21): "anyone who can read the workspace can read any branch, because they can read git anyways. Conversation itself stays private". The Security review had asked for a limit, because a conversation is private to its owner; the answer is that the committed work is in Git, which each reader of the Workspace can read. The messages of a conversation stay private, as today.
   - `read_file` and `list_files` use the same view as the search. `list_files` lists the paths of the view. `read_file` finds the file version of the path in the view and reads its blob from the Workspace Git. Thus a file of the default branch that the search finds on B is also in the file reads of B.

7. **One projection run for each branch tip.**
   - Each push to a branch queues a projection run for that (Workspace, branch). The GitHub push webhook queues it. A Workspace repository that is not on GitHub has no branch projection yet: only its default branch is projected, with its current triggers.
   - **One projection lease for each Workspace**, for all its branches (the lead, 2026-11-21, which amends the first version of this decision: a lease for each branch). Reason: with a lease for each branch, the cleanup can delete an old file version that no tree row uses while a run of another branch is about to use it (for example a revert to an old blob). With one lease, the runs and the cleanup of a Workspace go one at a time. A branch run is small, so the order costs little; the projection lag of each Workspace shows the wait.
   - A push that deletes a branch queues the same run. The run finds no tip in Git, and it deletes the head and the tree rows of the branch (decision 10).
   - A run projects the newest tip of its branch only. A run whose tip is already old when it starts ends with no work, as on the default branch today (ADR-067 decision 3).
   - For each path of its change set, a run uses the stored file version if it exists (from another branch or an earlier commit). Else, it converts and projects the file. Thus a new branch projects only the files that no other branch holds, and a branch with no commit of its own has an empty overlay.

8. **The projection makes only model calls that are cached by content.**
   - A run on a branch does the same work as a run on the default branch: convert, chunk, embed and describe images.
   - Each model call of the projection has a key from the content, in the org and the Workspace:
     - an embedding: `embedding_key` (the model, the dimensions and the scrubbed text; ADR-067 decision 5), read only from the chunks of the same org and Workspace;
     - an image text: (org, Workspace, blob SHA, vision model, prompt version) (ADR-066 decision 6).
   - Thus when a branch merges, the run of the default branch finds the cached results and pays no new model cost.
   - **Rule:** a new model call in the projection must have a key from the content in the same way, or it does not run on a branch. Each cache of a model call is in the org and the Workspace, and it has the walls of ADR-066 decision 9. No cache is shared between orgs: a hit would tell one org that another org holds the same file.

9. **No maintenance and no write-back on a branch** (the CTO: "is for now, we may decide to add it later").
   - These steps run only on the default branch: the maintenance job, the link fixes, the folder lists, the rename repairs, the semantic merges, and each other step that writes to the repository.
   - The old stack (Postgres, FalkorDB) stays on the default branch only. The plane replaces it.

10. **Lifecycle.**
    - When a branch is deleted in Git, its tree rows and its head are deleted.
    - A cleanup job deletes the file versions that no visible tree row uses, after a grace time, so that it does not race a run that is about to use them. It also deletes the tree rows that a newer visible row replaced.
    - A live branch has no time limit. There is no limit on the count of branches (the CTO: "No limit now"). An alert watches the count of branches and the projection lag of each Workspace.

11. **The default branch is a branch like the others** (the CTO: "yes default branch is branch as others, except during read when other branches apply the overlay"). It uses the same tables, keyed by its branch name. The differences are only: it has a full tree, the read of another branch applies its overlay on it, it gets the maintenance job (decision 9), and it is the default of the `branch` argument (decision 6).
    - **A rename of the default branch** (for example `master` to `main`) follows the default branch setting of the Workspace (the CTO: "yes follow the setting, make sure you test for this scenario"). The sequence:
      1. The setting names the new default branch. Only the setting moves. The first run of that branch builds its full tree. It uses the stored file versions, so it writes only tree rows. The head of a full tree records the time when it became the tree of the default branch.
      2. Until that run moves its head, reads of the default branch use the head with the newest such time: the tree of the earlier default branch. The deletion of the earlier default branch waits until then, also when Git deleted it first.
      3. When the head moves, the new branch is the default branch for each read. Then the run queues a run for each other branch, because each overlay must use the merge base with the new default branch. The run of the earlier default branch then deletes it (decision 10), or makes it an overlay if Git still has it.

## Consequences

- **Waits for the next major release:** the retirement of `knowledge_state` and of its column `attempt_shas` (decision 4, ADR-053).
- **The tables are rebuilt.** New ClickHouse migrations drop the content tables and make them in the shape of this ADR. No data moves: the rows are derived data (ADR-066 decision 11). The projection version changes too, so the next run of each Workspace is a full rebuild that writes the new tables.

- **Amends [ADR-066](ADR-066-knowledge-content-in-clickhouse.md):**
  - decision 2: `knowledge_state` has one row for each branch, with no `attempt_shas`;
  - decision 3: the content tables hold file versions, and a tree table joins them;
  - decision 5: the rows of a file depend on the file and its variant only;
  - decision 7: `missing` is calculated at read;
  - decision 8: a file version is written one time, and the cleanup job makes the `DELETE`s.
- **Amends [ADR-067](ADR-067-knowledge-projection-applies-git-diff.md):**
  - decision 1: the trees have versions and a head;
  - decisions 2 and 3: the state and the lease are for each branch;
  - decision 4: no `attempt_shas`, because the tree versions own the recovery;
  - decision 5: a changed file adds a file version and a tree row;
  - decision 6: a tombstone is a tree row;
  - decision 7: no stored `missing` row;
  - decision 8: a run retries from the head, and a content error makes a `failed` file version;
  - decision 9: the maintenance job runs on the default branch only;
  - decision 10: a read sees no partly applied commit.
- **Fewer mutations.** A run inserts file versions and tree rows. It deletes no content rows. Only the cleanup job and the deletion of a branch make `DELETE`s, in batches.
- **Cost of a branch:** its overlay rows, and model calls only for file content that no branch had before. A full tree is about 6 MB for 100k files; an overlay is the size of the diff of the branch.
- **The vector search filters by the view.** For our sizes, the search in one Workspace stays fast. A very large Workspace with many branches can need a check of the filter; the latency command of the eval measures it.
- **A view of a branch is its tip on the current default branch.** There is no merge or conflict logic in the plane. The view of B is not the same as a full projection of the tip of B when the default branch changed after the merge base: it shows those newer files of the default branch.
- **Tests** must prove that:
  - the default branch gives the same reads as before this ADR, and a run of one commit at a time equals a full rebuild;
  - the read rule, for each of these cases:
    - a file that B changed, added or deleted;
    - a file that the default branch changed after B forked;
    - a file that the default branch deleted and that B did not change;
    - a relation into a path that B deleted;
    - a merge of the default branch into B;
    - a file that B changed and then changed back;
  - each reader of the Workspace reads the session branch of a conversation of another user;
  - the tree table has the read and insert walls of ADR-066 decision 9, and each `DELETE` of the branch deletion and of the cleanup job has the org and Workspace predicates;
  - two branches that hold the same file share its rows;
  - a deleted branch leaves no tree rows, and its own file versions go after the grace time;
  - a run on a branch starts no maintenance, and makes no model call outside the content-keyed caches;
  - a reader never sees a half-written tree;
  - a rename of the default branch (the new branch appears, Git deletes the earlier one, then the new branch's first run completes) keeps the reads during each step, and builds the new tree from the stored file versions.

## Follow-ups

- **The branch selector of the chat (phase 4, built).** The CTO (2026-11-21): "replicate what's common in claude code/codex/T3/.... and other coding agent tools". The user picks a base branch, the conversation works on its own session branch from it (the model of ADR-048 today), and the user publishes from there. The build:
  - The composer of a new conversation lists each Git branch of the repository, without the session branches of conversations, with the default branch first. The default branch is the default choice.
  - The base branch is `conversations.base_branch`, null for the default branch. Until the first message, a prepare with another base branch changes it and replaces the sandbox of the old one. The first message fixes it: to start from another branch, the user starts a new conversation, as in the tools that the CTO names.
  - The session branch starts from the tip of the base branch. Each turn rebases it on the new tip of the base branch (ADR-048 option D), and its pull request targets the base branch. The tip of a base branch that is not the default branch comes from `git ls-remote` at each turn, because the Workspace row holds only the tip of the default branch.
  - The graph tools of the chat read the session branch when it has a knowledge head, else the base branch when it has one, else the default branch, and their output names the branch and the SHA that they served. A session branch gets its head after a push of it, through the branch runs of decision 9. Its overlay is on the default branch, as for each branch, so the plane needs no change for a base branch.
