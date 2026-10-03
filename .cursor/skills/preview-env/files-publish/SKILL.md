---
name: preview-env-files-publish
description: Conversation files, diff, automatic turn pushes, Create PR, Show PR, stale branch, and workspace file edits (preview-env).
disable-model-invocation: true
---

# preview-env files-publish

Conversation sandbox, session branch `ctxpipe/chat/{conversationId}/1`, GitHub pull request. The conversation's durable state is that branch: every turn that changed files is committed and pushed by the backend broker. The UI keeps only **Create PR** (squashes the turn commits) and **Show PR**; **Commit+Push is removed** (ticket 02). Chat never pushes the default branch. [Harness](../harness.md) write policy applies (see [run-setup](../run-setup.md#write-policy)). Flow format: [run-setup](../run-setup.md#flow-format).

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

### FP-4 Turn commits are pushed automatically
**Requires** CHAT-2 and `needs-ticket-02` (until the broker push lands this is `SKIP(needs-ticket-02)`); Workspace `Writable`.
**Steps**
1. In the conversation, ask the agent to write `knowledge/preview-env/{run-id}-turn.md` with a short summary of a template file.
2. When the turn ends, look for any **Commit+Push** or **Pushing…** control.
3. Check the branch on GitHub.
4. *Uncertain:* repeat with the file edit from FP-2 and the next turn; record whether the user's own saved edit is committed on save or with the next turn.

**Expect (UI)** no **Commit+Push** or **Pushing…** anywhere (including Files empty-state copy); the header shows the branch `ctxpipe/chat/{conversationId}/1` (short name `chat/1`) and **Create PR**.
**Expect (backend)** the branch exists on GitHub with a commit for the turn (model-written subject, not a placeholder); `lastBranch` on `GET /{orgSlug}/api/v1/conversations/{id}` has the prefix `ctxpipe/chat/{conversationId}/`; a turn that changed nothing creates no commit; the broker pushes, the sandbox holds no write credential.
**Budget** 10 s / 30 s, turn end to the commit on the branch.
**Evidence** `FP-4-1.png`; `gh api repos/{GH_TEST_ORG}/…/commits?sha=<branch>`; trace.

### FP-5 Create PR and Show PR
**Requires** FP-4 (two or more turn commits on the branch: run FP-4 twice).
**Steps**
1. Click **Create PR**; wait out **Creating PR…**.
2. Click **Show PR**.

**Expect (UI)** the button becomes **Show PR** with an `href` to `github.com/…/pull/N`; the PR is left open (never merged unless `merge-pr`).
**Expect (backend)** the PR exists targeting the default branch and has **one** commit (the turn commits squashed); title starts with `[preview-env]` (*uncertain:* whether the product lets the run set the title; if not, close the PR after the run and note it); the conversation's PR state is `open`.
**Budget** 10 s / 30 s, **Create PR** to **Show PR**.
**Evidence** `FP-5-1.png`; `gh pr view --json commits,title,url`; trace of the pull-request request.

### FP-6 Stale branch hides publish actions
**Requires** FP-5 not yet merged; a human or `gh` able to push to the default branch of `preview-env-{run-id}-ws`.
**Steps**
1. Push a commit to the default branch that edits the same file the conversation changed.
2. Open the conversation and send one message.
3. Read the header and the Files pane.

**Expect (UI)** the conversation either shows **Branch needs a rebase** (conflict) or silently catches up (no overlap); while stale, **Create PR** is hidden; after the agent resolves the conflict the action returns.
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

- **PASS** FP-1, FP-2, FP-3 `PASS`; FP-4 to FP-6 `PASS` or `SKIP(needs-ticket-02)`; FP-7 `PASS` or `SKIP`.
- **SKIP** read-only Workspace, or flags not set (write policy).
- **FAIL** a save, push, or PR error on a **Writable** Workspace; **Show PR** never appearing; a **Commit+Push** control still present after ticket 02; a PR with unsquashed turn commits.
