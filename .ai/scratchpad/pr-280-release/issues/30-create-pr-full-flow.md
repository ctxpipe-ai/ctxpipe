# The full flow from changed files to an open pull request works end to end

Status: in progress
Priority: P0
Owner: claude
Blocked by: none
Created: 2026-10-11
Updated: 2026-10-11

## Context

Ticket 20 fixed separate causes of failed Commit+Push and Create PR (lock contention, GitHub refusals with no message, no UI error). Those fixes have contract tests, but nobody has run the full flow on a deployed preview with a real GitHub connection. Until 2026-10-11 the pr-280 preview used the production GitHub App, and no test org had a linked GitHub account.

pr-280 now uses the preview GitHub App, and the team has a test org on pr-280 that is connected to GitHub.

## Scope

A user in a Workspace on a writable GitHub repository can complete each step, and each step shows a clear result:

1. Change files. Use the chat agent, and also the Files panel if it can edit.
2. See the changed files marked in the file tree, and their diff.
3. Commit+Push. The branch appears on GitHub with the commit.
4. Create PR. The pull request opens on GitHub against the correct base branch, with a sensible title and body, and the UI shows a link to it.
5. Later changes in the same conversation push to the same branch and update the same pull request.
6. Each failure shows a message that tells the user what to do.

## Acceptance criteria

- [ ] The full flow passes on pr-280 two times in a row, in new conversations, with evidence: screenshots, the GitHub PR URL in a test repository, and trace ids.
- [x] Each defect found has a failing test first and a fix, as the tdd skill says.
- [x] Ticket 20 Open items are resolved or moved here.

## Comments

- 2026-10-11 (claude): **first run on pr-280** (before the fixes below deploy). Driver: headless Playwright, signed in as the team's test org. Test repository: private `ctxpipe-ai/pe-pr-flow-20261011-003046`, made from `preview-env-seed-knowledge`; a new Workspace on it. Screenshots are in `/tmp/preview-env/t30/` on the agent host.
  1. **Change files, chat agent: partial.** The agent wrote `knowledge/rewards/referral-bonus.md` and linked it from `loyalty-program.md`. It could not commit: `Author identity unknown` (`10-chat-turn1.png`). Defect 1.
  1. **Change files, Files panel: FAIL.** **New file** at the repository root shows **Could not save**: `write failed: sh: line 1: referral-faq.md: Is a directory` (`52-file-created.png`). Repeated after the ticket 29 and 31 deploy: same result. Defect 4.
  2. **Changed files and diff: FAIL.** The tree marks `AGENTS.md` as modified, and the diff lists 23 files. Only 2 are the agent's; the others are ctx| knowledge commits that reached `main` during the turn. Files status says `ahead: 3` (`22-files.png`, `40-after-create-pr.png`). Defect 2.
  3. **Commit+Push (Sync): PASS.** Sync took 6 s. The session branch is on GitHub with one commit, `ctxpipe: Add Referral Bonus Documentation`, with only the 2 changed files.
  4. **Create PR: FAIL.** Two attempts answer 502 `github_unavailable`; the toast says **Create PR failed. GitHub did not answer. Try again.** The log has GitHub 422 `not all refs are readable`. Traces `e0833dead876276ac44f4764f6066b3f` (00:46:53Z) and `bf67a0bbe46943af32b854a8390f9e94` (01:01:27Z). Defect 3.
  5. **Later changes update the same PR: not run.** It needs step 4.
  6. **Failure messages: partial.** Sync and the Files panel show an error. The Create PR toast blames GitHub availability for a refusal; see follow-ups.
- Other observations: a full page reload signed the session out and lost the conversation path (ticket 29 targets this). A new Workspace reports `hydrateStatus: ready` while ctx| still pushes knowledge commits to `main` for about 2 minutes, so the first conversation starts behind and shows **Branch needs a rebase** for a short time. The `migration_export` commit in the new repository copied knowledge from another repository of the org (`knowledge/apis/*` from a demo app); the team lead should check if that is intended.
- Ticket 20 Open items: the GitHub App configuration item is resolved (pr-280 uses the preview App). The "confirm cause 2" item now has its evidence: the refusal is defect 3, not a missing permission.

- 2026-10-11 (claude): **acceptance run on pr-280** after the ticket 30 deploy (`0d3b9e9b`, then the ticket 34 deploy `1e47aa1b`). Driver: headless Playwright as the team's test org. Test repository: private `ctxpipe-ai/pe-pr-flow-20261011-043621` (from `preview-env-seed-knowledge`), a new Workspace, `main` left to settle for 2 minutes after hydrate. Each run starts in a new conversation. Screenshots: `/tmp/preview-env/t30/r{1,2,3}-*.png` on the agent host.
  - **Run 1: PASS (steps 1 to 5).** (1) The agent wrote `referral-bonus-1.md`, linked it, committed `docs: add referral bonus knowledge` and pushed it itself (no identity error). The Files panel **New file** at the root saved (the root-file fix works). (2) The tree marks the new file `A` and `knowledge/` changed; Diff lists exactly the 3 own files. (3) Sync took 6 s; the branch has the agent commit and the Sync commit. (4) Create PR took 4 s and showed **Show PR**: [PR 1](https://github.com/ctxpipe-ai/pe-pr-flow-20261011-043621/pull/1), base `main`, title "Add Referral Bonus Documentation", body empty. (5) A follow-up turn committed and pushed to the same branch; PR 1 got the third commit, and no second PR opened. Traces: push `6625bae2f00d2d8c2581747dec1816d9`, pull request `fac3526f06212730b9e1be67e8d00c97`. (The run script sent "undefined" in the run number of two names; that is a script error.)
  - **Run 2: interrupted by a deploy.** Steps 1 to 4 passed ([PR 2](https://github.com/ctxpipe-ai/pe-pr-flow-20261011-043621/pull/2); traces `b0fae6eab593730c83befac843cdcf22`, `33c2bfe63234ff159866e3a42b165d25`). Step 5 failed with "Database not initialized" while PR Deploy `4df6268a` restarted pr-280 (04:50 to 04:54 UTC). Restarted as run 3.
  - **Run 3: PASS (steps 1 to 5).** Same results as run 1: agent commit and push, Files panel save, 3 own files in Diff, Sync 6 s, [PR 3](https://github.com/ctxpipe-ai/pe-pr-flow-20261011-043621/pull/3) in 4 s with 3 commits after the follow-up turn on the same branch. Traces: push `e531b6fd1169b2ad07b7070ef3e97192`, pull request `a8897060ee6972a980ddf31728b899bf`.
  - **Step 6:** no failure occurred in runs 1 and 3, so no live message was seen. The first run's toasts and the `pr_refused` and UI tests cover it.
  - **Gaps found (not fixed in this pass):**
    1. Run 2's PR title is the agent's first sentence with a line break ("I'll inspect the repository, … \n\nRe"). Cause: `nameConversationIfUnnamed` (`conversation-title.ts`) accepts the title model's reply as it is, only trimmed and cut to 100 characters, so a model that answers with a sentence names the conversation, and Create PR uses that name as the title and the Sync commit subject. Fix: keep the first line, limit the words, else use the fallback.
    2. Every PR body is empty. The route passes `body ?? ""` and the UI sends no body. The Scope asks for a sensible body.
    3. In runs 1 and 2, keystrokes typed into a new file in the Files panel were lost: run 1 saved only the end of the text, run 2 saved only "#" and then showed a diff view ("No newline at end of file") with the dirty dot. Run 3 saved all of the text. To check: the editor may remount, or reload the saved body, after the first autosave of a new file.
    4. After run 1's follow-up turn, the open Diff pane still listed 3 files; the status API listed the 4th file (`referral-bonus-undefined.md`). The ticket 34 changed-files card showed the right 2 files for turn 1.
  - Test PRs 1, 2, and 3 are closed.
  - Acceptance box 1 stays open: runs 1 and 3 pass steps 1 to 5 in a row, but step 4 asks for a sensible body (gap 2), and run 2 showed a bad title (gap 1). Close it after those two are fixed and one more run passes.

## Resolution

Four defects, each with a failing test first (commits on branch `t30-pr-flow`):

1. **The agent cannot commit** (`6276cf40`). The sandbox had no Git identity, and the agent commits with plain `git` before `push_conversation_branch`. The thread setup now sets the ctx| identity in the clone. Test: `chat-runtime.test.ts`.
2. **The diff shows the Workspace's own commits** (`6d12b99e`). Status and diff compare with the local default branch, which stayed on the old commit when a turn moved the session branch to a newer Workspace commit. The revision transition now moves the local default branch too, when that drops no commit. Test: `conversation-files.test.ts`.
3. **Create PR always fails** (`4ac77c6a`). The PR token asked only for Pull requests: write. GitHub reads both branches with that token, so it refused with 422 `not all refs are readable`. The token now also asks for Contents: read. The fixture now grants only the permissions a token request names. Test: `conversation-branch-push-native.contract.test.ts`.
4. **A root file cannot be saved in a Docker sandbox** (`59f98455`). The Docker handle runs `mkdir -p` on the path before the last `/`, so a root file became a directory. The write now prefixes `./`. Test: `conversation-files.test.ts`.

Review round 1 (2026-10-11): fix 2 now compares status and diff with `refs/remotes/ctxpipe/base`, so the advance, the rotation after a merged PR, and the agent's repair rebase are all covered (`a3c31a8d`; the local branch move is gone). A GitHub 422 other than `No commits between` answers 400 `pr_refused` with GitHub's reason, and the toast names it (`c7c064ef`). Every sandbox file path starts with `./` (`78e53098`). The Git identity is set in the checkout step (`2654592b`). `listSandboxInstances` filters by org in the query, so a role that skips row-level security cannot sweep other orgs' sandboxes (`c6f0ce2d`).

Needs a deploy to prove: all fixes. After the deploy, run the full flow two times in new conversations (acceptance criterion 1), including step 5.

Follow-ups: delete the test repository (the `gh` token has no `delete_repo` scope).
