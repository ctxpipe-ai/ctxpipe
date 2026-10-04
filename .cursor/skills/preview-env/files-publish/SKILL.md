---
name: preview-env-files-publish
description: Conversation files, diff, agent and Commit+Push commits, Create PR, Show PR, stale branch, and workspace file edits (preview-env).
disable-model-invocation: true
---

# preview-env files-publish

Conversation sandbox, session branch `ctxpipe/chat/{conversationId}/1`, GitHub pull request. The agent decides when to commit and push to that branch: when the user asks, or when it finishes a task (its system prompt recommends committing then), with semantic commit messages. The conversation header offers **Commit+Push** (for anything not yet committed, including the user's own edits), **Create PR** (keeps every commit; no squash), and **Show PR** (decided 2026-10-04). Chat never pushes the default branch. [Harness](../harness.md) write policy applies (see [run-setup](../run-setup.md#write-policy)). Flow format: [run-setup](../run-setup.md#flow-format).

If **Settings** shows **Read-only**, publish controls are hidden: `SKIP(no-fixture)` the write flows, not FAIL.

### FP-1 Browse conversation files
**Requires** CHAT-1 (a conversation) and a hydrated Workspace 1.
**Steps**
1. On the conversation URL, open **Files**.
2. Single-click a file; double-click another; use **Hide tree** / **Show tree**.

**Expect (UI)** the tree shows the workspace repository as this conversation sees it; single-click previews with the tree staying open; double-click opens a closeable named tab (`pane=file:<path>`); **Hide tree** / **Show tree** appear only after a file is selected.
**Expect (backend)** `GET …/conversations/{id}/files/tree` and `…/files/blob` return 200 (the sandbox starts or resumes if needed).
**Budget** 2 s / 8 s to the tree (plus up to 3 s if the sandbox must resume).
**Evidence** `FP-1-1.png`; trace of the tree request.

### FP-2 Create and save a file in a conversation
**Requires** FP-1; Workspace `Writable`.
**Steps**
1. In **Files**, create `ctxpipe-preview-sweep/{run-id}/note.md` (**New file**), write one line naming `run-id` and the origin, and save (autosave or **Save**).

**Expect (UI)** the tree shows the path and the editor holds the line; no stale-worktree error left on screen (a `stale_worktree` error retries on its own).
**Expect (backend)** the file exists in the conversation sandbox (`PUT …/files/blob` returned 200; `GET …/files/status` shows it dirty or committed).
**Budget** 2 s / 8 s, save to confirmed.
**Evidence** `FP-2-1.png`; trace.

### FP-3 Diff pane
**Requires** FP-2.
**Steps**
1. Click **Diff** (`pane=diff`).

**Expect (UI)** the new path appears in the diff list against the default branch.
**Expect (backend)** `GET …/conversations/{id}/files/diff` returns 200 with that path.
**Budget** 2 s / 8 s.
**Evidence** `FP-3-1.png`.

### FP-4 Agent commits and pushes; Commit+Push publishes the rest
**Requires** CHAT-2; FP-2's saved file; Workspace `Writable`.
**Steps**
1. In the conversation, ask the agent to write `knowledge/preview-env/{run-id}-turn.md` with a short summary of a template file and say the task is done. Do not mention committing. When the turn ends, record whether the agent committed and pushed on its own.
2. Ask the agent to commit and push its work.
3. Check the branch on GitHub.
4. Click **Commit+Push** in the conversation header to publish FP-2's saved file (the user's own edit); wait out **Pushing…**.

**Expect (UI)** the header shows the branch `ctxpipe/chat/{conversationId}/1` (short name `chat/1`), **Commit+Push**, and **Create PR**; after step 2 the agent's reply says it committed and pushed; step 4 shows **Pushing…**, then clears with no error.
**Expect (backend)** the branch exists on GitHub with the agent's commit (a semantic subject such as `docs: …`, not a placeholder) after step 1 or step 2, and a further commit with FP-2's file after step 4; nothing is pushed to the default branch; `lastBranch` on `GET /{orgSlug}/api/v1/conversations/{id}` has the prefix `ctxpipe/chat/{conversationId}/`; on `preview` the sandbox still holds no write credential ([CHAT-8](../chat/SKILL.md)).
**Budget** 10 s / 30 s, the agent's reply (step 2) or **Commit+Push** (step 4) to the commit on the branch.
**Evidence** `FP-4-1.png` (header after step 2), `FP-4-2.png` (after step 4); `gh api repos/{GH_TEST_ORG}/…/commits?sha=<branch>`; trace.

### FP-5 Create PR and Show PR
**Requires** FP-4 (two or more commits on the branch).
**Steps**
1. Click **Create PR**; wait out **Creating PR…**.
2. Click **Show PR**.

**Expect (UI)** the button becomes **Show PR** with an `href` to `github.com/…/pull/N`; the PR is left open (never merged unless `merge-pr`).
**Expect (backend)** the PR exists targeting the default branch and has **every** commit of the branch, unsquashed (at least two); title starts with `[preview-env]` (*uncertain:* whether the product lets the run set the title; if not, close the PR after the run and note it); the conversation's PR state is `open`.
**Budget** 10 s / 30 s, **Create PR** to **Show PR**.
**Evidence** `FP-5-1.png`; `gh pr view --json commits,title,url`; trace of the pull-request request.

### FP-6 Stale branch hides publish actions
**Requires** FP-5 not yet merged; a human or `gh` able to push to the default branch of `pe-{run-id}-ws`.
**Steps**
1. Push a commit to the default branch that edits the same file the conversation changed.
2. Open the conversation and send one message.
3. Read the header and the Files pane.

**Expect (UI)** the conversation either shows **Branch needs a rebase** (conflict) or silently catches up (no overlap); while stale, the publish actions (**Commit+Push**, **Create PR**) are hidden; after the agent resolves the conflict they return.
**Expect (backend)** the moved default branch is merged into the session branch in place before the turn; a merge commit or conflict note is on the branch.
**Budget** 15 s / 45 s, **Send** to the answer on the caught-up branch.
**Evidence** `FP-6-1.png`; commits on the branch.

### FP-7 Workspace Files edit on the default branch (`gated-default-branch-write`)
**Requires** flag `default-branch-write`; Workspace `Writable`.
**Steps**
1. On the bare Workspace URL (no conversation), open **Files**, save `ctxpipe-preview-sweep/{run-id}/workspace-note.md`.

**Expect (UI)** the file appears in the tree once the job finishes (**Files** reflects the committed revision, not a draft).
**Expect (backend)** a `workspace-file-edit` run produced **one** commit with a model-written subject on the default branch (fast-forward only); `workspace_write_jobs` row done; a re-hydrate follows ([HYD-3](../hydrate/SKILL.md)).
**Budget** 30 s / 2 min, save to the path in the tree.
**Evidence** `FP-7-1.png`; `gh api` commit; run id.

## Status

- **PASS** FP-1 to FP-6 `PASS`; FP-7 `PASS` or `SKIP`.
- **SKIP** read-only Workspace, or flags not set (write policy).
- **FAIL** a save, push, or PR error on a **Writable** Workspace; the agent not committing when asked; **Commit+Push**, **Create PR**, or **Show PR** missing; a PR whose commits were squashed.
