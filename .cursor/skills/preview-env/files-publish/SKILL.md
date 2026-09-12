---
name: preview-env-files-publish
description: Edit a conversation file, Commit+Push, and Create PR on a Railway PR preview.
disable-model-invocation: true
---

# preview-env files-publish

Conversation sandbox → session branch `ctxpipe/chat/{conversationId}/1` → GitHub PR. Prefer the conversation from [chat](../chat/SKILL.md). [Harness](../harness.md) write policy applies. One `computerUse` task.

If Settings shows **Read-only**: publish controls are hidden. **SKIP** writes (not FAIL).

## 1. Edit in Files

On the conversation URL, open **Files**. Create or save:

`ctxpipe-preview-sweep/{run-id}/note.md`

Content: one line naming `run-id` and the preview origin. New file / save in the Pierre tree.

**Done when:** the tree shows that path and the editor has the line (or git status is dirty for that path).

## 2. Diff

Open **Diff** (`pane=diff`). The new file (or hunk) is listed versus the default branch.

**Done when:** `pane=diff` and the sweep path appears in the diff list.

## 3. Commit+Push

Click **Commit+Push** (label becomes **Pushing…**). Wait until it returns to **Commit+Push** or a branch chip `ctxpipe/chat/…` is visible.

**Done when:** chrome shows a `ctxpipe/chat/{conversationId}/` ref **or** `GET /{orgSlug}/api/v1/conversations/{id}` has `lastBranch` with that prefix.

## 4. Create PR

Click **Create PR** (then **Creating PR…**). It becomes **Show PR** with an `href` to `github.com/…/pull/N`. Title prefix `[preview-env]`. Do not merge.

**Done when:** **Show PR** is visible and the href contains `/pull/`.

## 5. Default-branch write (gated)

Only with `default-branch-write`: on the workspace (no conversation) Files pane, save the same sweep prefix via workspace file jobs. That pushes the **default** branch.

**Done when:** SKIP, or the workspace Files tree shows the path after the job finishes.

## Status

- **PASS** — steps 1–4 met (5 SKIP or met).
- **SKIP** — read-only workspace, or the user did not ask for a full sweep / this area (harness write policy).
- **FAIL** — save/push/PR errored on a **Writable** workspace, or **Show PR** never appeared.
