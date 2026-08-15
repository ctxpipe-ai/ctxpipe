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

### Round 3 (human, 2026-08-15)

- **Q10:** One **write sandbox per Project**. Concurrent jobs get **in-sandbox `git worktree`s**; cap concurrency in code; `SandboxHandle.process.spawn`. Mechanical GitHub-API mirrors skip an agent slot. Product chat stays per-thread `withSandbox`.
- **Q11:** Connector mirrors and extract ingest are **separate jobs / separate commits**.
- **Q12:** v1 trigger: enqueue after a successful hydrate if work remains. **Do not hard-allowlist paths** — future write jobs may touch other files. Bootstrap allowlist from [Project repository create, select, relink, and import](09-project-repository-lifecycle.md) stays a bootstrap rule, not a write-protocol law.
- **Q13:** Ops / folder-map is a **second job**. Ingest commit stands if ops fails; ops retries.
- **Q14:** Git rename similarity (default 50%) plus hydrate path-id change. Skip ambiguous many-to-one, binaries, hydrate-skipped malformed. Don’t invent targets.
- **Q15:** Retry hydrate. Don’t revert the commit. `hydrate_status` stays dirty until it succeeds.
- **Q16:** Probe on the next write intent and on a cheap periodic check. Resume current-generation paused intents when writable. Relink stays allowed.

## Answer

Linear pipeline: **in-sandbox worktree → at most one commit on the remote default branch → push (fast-forward or rebase + semantic merge) → hydrate**. Git is canonical. The serving DB moves only via hydrate.

**Refuse:** silently committing to `main`; opening a PR because the default branch is protected (that is read-only + tooltip); force-pushing origin; one job emitting many commits; a host `git worktree` as isolation; per-job sandbox forks; each write job calling `withSandbox` (that forks or locks a harness).

### Commit

- Target the remote’s **default branch**.
- Author: GitHub App installation.
- Subject: **LLM-generated** on every commit (including mechanical syncs). Tiny context (names, not bodies). Small model, chosen in code, not an operator env.
- One write job → at most one commit. No file changes → skip.
- UI/docs: ctxpipe manages context and will create **many** individual commits. Existing connector **config.yaml** PRs stay.

### Conflict

If the push is not a fast-forward: rebase the **unpushed** job commit onto default tip; a sandboxed agent merges semantically; never force-push. Failure fails **that job** (retry later), not the Project.

### Sandbox (write path, not chat)

Product chat stays [Chat uses TanStack sandbox, not DIY OpenCode](17-tanstack-sandbox-not-diy-opencode.md): `chat()` + `withSandbox` per `threadId`.

Write-path agents (ingest extract, maintenance, ops/bootstrap, semantic rebase) share **one write sandbox per Project**. They attach to that handle and `spawn` (or equivalent) against a worktree path. They do **not** each call `withSandbox`. Mechanical GitHub `commitFiles` mirrors **skip** the sandbox and the worktree.

Each job: create an **in-sandbox `git worktree`**, do the work, commit, push, **delete the worktree**. The shared clone stays; idle/destroy of the write sandbox is [Worktree and agent-change lifecycle](14-worktree-and-agent-change-lifecycle.md). Cap how many worktrees/agents run at once **in code**.

Provider selection follows [Backend, codesearch, and sandbox-runner topology](08-backend-codesearch-sandbox-topology.md). Fargate v1 has no sandbox provider — write jobs there are unsandboxed until one exists. Workspace is the **backing** repo only.

### Jobs

| Job | Commit | Notes |
| --- | --- | --- |
| Extract ingest | Own | LLM may write markdown in the worktree. Partial or full: still one commit. |
| Connector mirror | Own | GitHub API today; no agent slot. |
| Maintenance | Own | v1: enqueue after successful hydrate if work remains. Other triggers later are allowed. Repairs: layer-1→`claims:`, rename refs, `valid_from` backfill, semantic merge. **No hard path allowlist.** |
| Ops / folder-map / bootstrap | Own | Allowlist applies to **bootstrap** only (`AGENTS.md` + `.agents/skills/ctxpipe-knowledge/**`). If ops fails, the ingest commit already on the default branch stays; ops retries. |

Rename rewrite uses git similarity (default 50%) plus the hydrate path-id change. Skip ambiguous many-to-one, binaries, and files hydrate skipped as malformed. Don’t invent targets. Reference updates may be this maintenance commit (still one commit for that job).

### After push

Hydrate the new SHA. If hydrate fails, **retry hydrate** — do not revert git. `hydrate_status` vs `write_status` stay distinct.

Unwritable backing: pause current-generation intents that maintain that URL (ingest, destination-only mirrors, maintenance, ops/bootstrap, **attach/detach** `repositories/*.md`). Probe on the next write intent and on a cheap periodic check; resume those intents when writable. Relink remains allowed. Hydrate, search, and project chat continue ([Project repository create, select, relink, and import](09-project-repository-lifecycle.md)).

Write jobs **recheck generation + desired backing URL + default branch** immediately before push. After relink they must not push to the old URL.

This ticket **supersedes** unsandboxed ops on 02/08/17: folder-map and bootstrap agents use the write sandbox.

Monotonic / CAS activation of a hydrated SHA (don’t let a slower hydrate of A overwrite B) is [Project revision and derived-store freshness](11-project-revision-and-freshness.md).

### Sol (2026-08-15) — do not close

Draft had holes. Folded without re-asking: generation recheck, attach/detach in the pause set, ops sandbox supersedes the old unsandboxed lock. Hydrate activation order parked on 11. Remaining decisions are round 4.
