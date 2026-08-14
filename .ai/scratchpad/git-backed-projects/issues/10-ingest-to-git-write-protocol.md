# Ingest-to-git write and concurrency protocol

Type: grilling
Status: claimed
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
- **Rename rewrite:** repair **as much as possible**. Reference updates **may be their own commit**. Hydrate does not invent targets. Settle detection (git similarity) and what “as much as possible” skips.
- **Maintenance job (hydrate Q12/Q15/Q19/Q22/Q25):** a write-path job **commits** repairs: upgrade markdown-only links to `claims:`, rewrite rename refs, persist `valid_from` (same introducing-commit value hydrate already derived read-only), semantic merge (layout Q6). May use unsandboxed TanStack `chat()` / extract LLM. **Hydrate never writes git.** Settle: trigger; one commit vs many; which files it may edit.
- **`AGENTS.md` ops agent:** maintains the **one** semantic folder-structure section (any heading/level the user chose). Keep user folders that exist; remove dead links. Settle: same commit as the folder add, or two? What if the agent fails?

Recommend a single linear pipeline: stage in worktree → one commit to the chosen branch → hydrate. Name any extra branch/PR flow you refuse, including "open a PR because main is protected" if you refuse it.

## Comments

### From [Project repository create, select, relink, and import](09-project-repository-lifecycle.md)

Write jobs carry a **generation** and target **desired** backing, never the previous URL after relink. Persist `write_status` vs `hydrate_status`. Unwritable backing → **pause** current-generation intents that maintain this URL (ingest, destination-only connector mirrors, maintenance, ops/bootstrap). Probe/retry/resume when writable. Bootstrap allowlist: root `AGENTS.md` + `.agents/skills/ctxpipe-knowledge/**` only. Protected-branch / required-PR is a `write_status` error with a specific tooltip.

### Round 1 (human, 2026-08-14)

- **Q1:** Commit to the remote’s **default branch** (never silently `main`).
- **Q2:** Direct fast-forward; no PR workaround for protection. Existing connector **config.yaml** PRs stay. UI/docs must say ctxpipe **automatically** manages context and will create **many** individual commits.
- **Q3:** Wants option 3 (jobs in a sandbox) and to **reopen unsandboxed ops** for prompt-injection protection. Wants multiple jobs in parallel in **one** sandbox — TanStack/git facts next round.
- **Q4:** GitHub App author. Subject is human-friendly and **LLM-generated** (sketch: `ctxpipe - Knowledge update of <repo> from <triggering commit>`).
- **Q5:** One write job → at most one commit; no-op skips.
- **Q6:** Conflict is **semantic** (agent), possibly `git rebase` first. Not “retry empty / fail”.

### Round 2 (human, 2026-08-14)

- **Q7:** Rejects per-job sandbox forks (scale). Wants **one shared sandbox**, many agents in parallel (I/O wait, not CPU). TanStack `chat()`+`withSandbox` is still one harness per `threadId`; same-id concurrent runs are locked. A container/VM **can** `spawn` multiple processes ([SandboxHandle.process](https://tanstack.com/ai/latest/docs/sandbox/providers)). One git **index** cannot. Mechanics in Q10.
- **Q8:** LLM subject on **every** commit, including mechanical syncs. **Tiny context** (e.g. Confluence file names, not bodies) and a **small model** (in code, not a new env). Acceptable cost.
- **Q9:** Fast-forward; else rebase the **unpushed** job commit onto default tip; sandboxed agent semantically merges; never force-push origin; fail the **job** (retry later), not the whole Project.
