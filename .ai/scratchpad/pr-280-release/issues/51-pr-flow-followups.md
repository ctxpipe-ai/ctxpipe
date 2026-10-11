# Create PR flow follow-ups: title, body, editor text, Diff refresh

Status: in progress
Priority: P1
Owner: claude
Blocked by: none
Created: 2026-10-11
Updated: 2026-10-11

## Context

Ticket 30 ran the full flow from changed files to an open pull request on pr-280. Runs 1 and 3 passed steps 1 to 5, but the run found four gaps (ticket 30, Comments, "Gaps found"). Ticket 30 keeps its first acceptance box open until gaps 1 and 2 are fixed and one more run passes.

## Scope

1. **The PR title can be the agent's first sentence, with a line break.** `nameConversationIfUnnamed` accepts the title model's reply as it is. The title must be one line, trimmed, with no quotes or trailing period, and at most about 72 characters. When the reply is empty or unusable, use a short title from the changed files.
2. **Every PR body is empty.** Give the PR a short summary of the conversation's changes (turn summaries or commit messages), the list of changed files, and a link to the conversation when the config has a public app URL. Use plain markdown and mask credentials (`maskCredentials`, ticket 32). Decide and implement what happens to the body when a later push updates an existing PR.
3. **The Files editor lost typed text in a new file** (runs 1 and 2; run 3 was fine). Reproduce it with the real editor component, find the cause, and fix it with a failing test first. If it does not reproduce, record what was tried and add a guard test for the most likely cause.
4. **The open Diff pane does not show a new file after a follow-up turn,** but the status API does. Refresh the Diff pane query when a turn ends, as the Files tree and the status do.

Rules: no new environment variables; do not change tab or button styles (other tickets change them).

## Acceptance criteria

- [x] Gap 1: a multi-line, quoted, very long, or empty title reply gives one clean line of at most 72 characters, with tests.
- [x] Gap 2: Create PR sends a body with the commit subjects, the changed files and the conversation link; a later push refreshes it; tests use msw on the GitHub API.
- [ ] Gap 3: a failing test first and a fix, or a record of what was tried and a guard test.
- [ ] Gap 4: the Diff pane refreshes when a turn ends, with a test or story.
- [ ] After a deploy, one more full-flow run on pr-280 shows a clean title and a body (closes ticket 30 box 1).

## Comments

## Resolution

1. **Title** (`c1b284e6`). `cleanTitle` in `conversation-title.ts` takes the first line that is not empty, removes a heading mark, a `Title:` label, quotes and a trailing period, and cuts at a word to 72 characters. The model's reply is refused when it has more than 8 words (a sentence, as in run 2), and the first user message is used. Create PR uses `pullRequestTitle`: the client title or the conversation name, cleaned; without a usable name, `Update <file>`, `Update <a> and <b>`, or `Update <a> and N other files`. The Commit+Push subject is cleaned too. Tests: `conversation-title.test.ts`, `pull-request-text.test.ts`.
2. **Body** (`04897b21`). Create PR reads GitHub's compare of the default branch and the session branch, and writes a body in a marked ctx| section: the commit subjects, the changed files (at most 50), and a link `{AUTH_BASE_URL}/{org}/ws/{workspace}/{conversation}`. The body is masked with `maskCredentials`. A failed compare gives a body without commits and files, so the PR still opens. A client body, if sent, is used and masked.
   - **Later pushes: decision.** After each push from the conversation (agent tool, Commit+Push, Create PR), the open PR's ctx| section is replaced with a current one. Text a person adds around the section stays. An empty body gets the section. A body a person rewrote without the section is not changed. Reason: the file list stays correct as the conversation adds commits, and nobody loses their own text. A failed refresh is logged and does not fail the push.
   - Tests: `pull-request-text.test.ts` (format, masking, refresh rules) and a new contract test in `conversation-branch-push-native.contract.test.ts` (msw on the GitHub API, with the fixture's compare served from the real remote): the created PR has the cleaned title, the summary, the files and the link; a later agent push refreshes the section and keeps a reviewer note; a rewritten body stays.
3. **Editor text** (open). A sub-agent works on it in `WorkspacePierreFile.tsx` and `WorkspacePane.stories.tsx`; the work is not committed yet.
4. **Diff refresh** (`c944ecac`, sub-agent). The Diff pane query refreshes when a chat turn ends.
