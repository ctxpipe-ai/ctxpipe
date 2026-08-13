# Worktree and agent-change lifecycle

Type: grilling
Status: open
Blocked by: 08, 09, 13

## Question

Lock the git worktree used by project chat: when it is created, what the UI calls it, and **what happens to OpenCode's writes**.

The brief: before the first file change, create a worktree and never modify the main tree (fallback: always create the worktree before starting the sandbox). UI shows a friendly name, in the same spirit as Claude / Codex / Cursor.

The file-edit *panel* is out of scope. Leaving agent writes in a discarded worktree with no rule is not.

Settle:

- Always-create vs lazy-on-first-write. (Always-create is the allowed fallback.)
- Worktree naming scheme shown in the UI.
- Where the worktree lives (which deployable from [Backend, codesearch, and sandbox-runner topology](08-backend-codesearch-sandbox-topology.md)).
- Disposition of writes: commit to default branch, commit to a session branch, open a PR, keep uncommitted until the user acts, discard on conversation delete?
- Lifetime: per conversation until delete; idle timeout; crash recovery (worktree still there, sandbox gone).
- Garbage collection: who prunes worktrees, and when.
- Relation to ingest worktrees (those are job-scoped and die after the ingest commit).

Recommend always-create per conversation unless research shows lazy-create is cheap and airtight. Default disposition: **do not commit to the Project's default branch from chat** unless the user (or a later ticket) says so — chat worktrees are not ingest. If you reject that default, say what stops two conversations from racing ingest's one-commit-to-main rule.
