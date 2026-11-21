# ADR-071: The knowledge plane projects every branch: shared file versions, a full tree for the default branch, an overlay for each other branch

**Status:** Accepted (the CTO, 2026-11-21; [CTX-1457](https://linear.app/ctxpipe/issue/CTX-1457): built: the file versions, the trees and heads of all branches, the overlays, branch runs from GitHub pushes, the MCP `branch` argument, branch deletion and the cleanup; the read rule of a conversation session branch waits for the CTO's answer to the open question) | **Date:** 2026-11-21 | **Tags:** knowledge, clickhouse, branches, git, mcp, consistency

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
   - A file that does not parse, convert or embed gives a `failed` file version with the error. The error depends only on the content, so it is shared too.

3. **Each branch has a tree.**
   - A **tree row** says which file version a branch holds at a path: (org, Workspace, branch, path) → (blob SHA, variant), or a tombstone with `deleted_at`. It also holds the values that depend on the branch, for example `valid_from`.
   - **The default branch has a full tree:** one row for each document path of its tip, and a tombstone for each path that it removed.
   - **Each other branch has an overlay** (the CTO: "B. overlay - full tree would be too large/expensive on large repos"). The overlay of branch B holds only the paths whose file version at the tip of B is different from the file version at the merge base of B and the default branch. A changed or added path gets its file version. A deleted path gets a tombstone.
   - The overlay comes from the Git diff from the merge base to the tip. Thus it changes only when B gets a commit, or when a merge of the default branch into B moves the merge base. A move of the default branch does not change the overlay of B.
   - A path can leave the overlay: B changes a file back to its version at the merge base, or a merge of the default branch makes the path the same as at the new merge base. Then the run writes an **inherit** row for the path. An inherit row removes the path from the overlay, so the view of B takes the row of the default branch again. A tombstone is different: it removes the path from the view of B.
   - The tree table is a sixth shared table. It has the sort key prefix `(org_id, workspace_id, …)`, the `CHECK` constraint and the row policy of ADR-066 decision 9. The writer user inserts and deletes its rows, and the reader user only reads them. `KnowledgeStore` adds the org and Workspace predicates to each `DELETE` of it, also the `DELETE`s of the branch deletion and of the cleanup job. A read joins a tree row to its file version on the org, the Workspace, the path, the blob SHA and the variant: the same path and blob can exist in two orgs.

4. **A run never shows a half-written tree.**
   - Each branch has one **head**: its row of the Postgres table `knowledge_branch_heads` (org, Workspace, branch), with the projected tip, the tree version and, for an overlay, the merge base. The reader and the writer use only this table, also for the default branch.
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

6. **Reads take one branch.**
   - `search_knowledge`, `get_related`, `read_file`, `list_files` and the UI read one branch.
   - Each MCP tool gets an optional `branch` argument. Its default is the default branch of the Workspace.
   - Each member of the Workspace can read each branch (the CTO: "everyone in the workspace"). Who can read a conversation session branch is an open question for the CTO (see "Open questions").
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
  - the read rule for a conversation session branch, after the CTO answers the open question;
  - the tree table has the read and insert walls of ADR-066 decision 9, and each `DELETE` of the branch deletion and of the cleanup job has the org and Workspace predicates;
  - two branches that hold the same file share its rows;
  - a deleted branch leaves no tree rows, and its own file versions go after the grace time;
  - a run on a branch starts no maintenance, and makes no model call outside the content-keyed caches;
  - a reader never sees a half-written tree;
  - a rename of the default branch (the new branch appears, Git deletes the earlier one, then the new branch's first run completes) keeps the reads during each step, and builds the new tree from the stored file versions.

## Open questions

1. **Who can read a conversation session branch?** The chat agent pushes the work of a conversation to the session branch `ctxpipe/chat/<conversation>/<n>` ([ADR-048](ADR-048-native-postgres-sandbox-ownership.md)). Today only the owner of a conversation can open it. If each member of the Workspace can read each branch, each member can read the committed work of another user's private conversation through `search_knowledge` or `read_file`. The Security review asked for a limit. The options:
   - **A.** A conversation session branch is readable only by the actor that can open its conversation: its owner, or the org MCP actor for an MCP conversation. Each other branch is readable by each member of the Workspace. This keeps the privacy of a conversation, and the chat agent still gets the graph of its own work.
   - **B.** Each member of the Workspace can read each branch, also a conversation session branch. The committed work of a conversation becomes visible to the Workspace.

   No reader serves a branch that is not the default branch until the overlays are built. That work keeps the rule in one place, and it does not merge until the CTO answers.

