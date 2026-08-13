# Ingest-to-git write and concurrency protocol

Type: grilling
Status: open
Blocked by: 02, 03, 08, 09

## Question

Lock the **write path** for ingestion (partial or full):

- One ingest = **one commit** to the project repository.
- Ingestion must **not** persistently save extracted content to the DB.
- DB updates only via hydrate from that commit.
- Stage in a **git worktree**, then commit to **main** — unless this ticket replaces `main` with the default branch, and says so.

Today extractors write Postgres then FalkorDB then embeddings. Connector syncs already commit via the GitHub API (`installation-write-client`) without a server-side worktree.

Settle:

- Author of the commit (GitHub App installation)? Message convention?
- `main` vs the repository's default branch vs protected-branch / required-PR reality.
- Partial ingest: still one commit?
- No-op ingest (no file changes): skip the commit?
- Worktree location and lifetime for ingest (not chat).
- Hydrate fails after a successful push: git is ahead; retry hydrate. Confirm.
- Connector mirrors vs extracted claims: same commit as extraction, or connectors keep their own commits?
- Concurrent human (or another ingest) push while the worktree is staging: rebase, retry, or fail?
- Extractor/hydrator split: LLM may **write markdown in the worktree**; hydrate never calls an LLM.

Recommend a single linear pipeline: stage in worktree → one commit to the chosen branch → hydrate. Name any extra branch/PR flow you refuse, including "open a PR because main is protected" if you refuse it.
