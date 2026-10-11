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
- [ ] Each defect found has a failing test first and a fix, as the tdd skill says.
- [ ] Ticket 20 Open items are resolved or moved here.

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

## Resolution

Four defects, each with a failing test first (commits on branch `t30-pr-flow`):

1. **The agent cannot commit** (`6276cf40`). The sandbox had no Git identity, and the agent commits with plain `git` before `push_conversation_branch`. The thread setup now sets the ctx| identity in the clone. Test: `chat-runtime.test.ts`.
2. **The diff shows the Workspace's own commits** (`6d12b99e`). Status and diff compare with the local default branch, which stayed on the old commit when a turn moved the session branch to a newer Workspace commit. The revision transition now moves the local default branch too, when that drops no commit. Test: `conversation-files.test.ts`.
3. **Create PR always fails** (`4ac77c6a`). The PR token asked only for Pull requests: write. GitHub reads both branches with that token, so it refused with 422 `not all refs are readable`. The token now also asks for Contents: read. The fixture now grants only the permissions a token request names. Test: `conversation-branch-push-native.contract.test.ts`.
4. **A root file cannot be saved in a Docker sandbox** (`59f98455`). The Docker handle runs `mkdir -p` on the path before the last `/`, so a root file became a directory. The write now prefixes `./`. Test: `conversation-files.test.ts`.

Review round 1 (2026-10-11): fix 2 now compares status and diff with `refs/remotes/ctxpipe/base`, so the advance, the rotation after a merged PR, and the agent's repair rebase are all covered (`a3c31a8d`; the local branch move is gone). A GitHub 422 other than `No commits between` answers 400 `pr_refused` with GitHub's reason, and the toast names it (`c7c064ef`). Every sandbox file path starts with `./` (`78e53098`). The Git identity is set in the checkout step (`2654592b`). `listSandboxInstances` filters by org in the query, so a role that skips row-level security cannot sweep other orgs' sandboxes (`c6f0ce2d`).

Needs a deploy to prove: all fixes. After the deploy, run the full flow two times in new conversations (acceptance criterion 1), including step 5.

Follow-ups: delete the test repository (the `gh` token has no `delete_repo` scope).
