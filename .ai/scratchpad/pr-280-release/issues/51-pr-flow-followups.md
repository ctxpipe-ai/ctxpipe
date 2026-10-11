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
- [x] Gap 2: Create PR sends a body with the commit subjects and the conversation link; tests use msw on the GitHub API.
- [x] Gap 3: a failing test first and a fix, or a record of what was tried and a guard test.
- [x] Gap 4: the Diff pane refreshes when a turn ends, with a test or story.
- [ ] After a deploy, one more full-flow run on pr-280 shows a clean title and a body (closes ticket 30 box 1).

## Comments

## Resolution

1. **Title** (`c1b284e6`). `cleanTitle` in `conversation-title.ts` takes the first line that is not empty, removes a heading mark, a `Title:` label, quotes and a trailing period, and cuts at a word to 72 characters. The model's reply is refused when it has more than 8 words (a sentence, as in run 2), and the first user message is used. Create PR uses `pullRequestTitle`: the client title or the conversation name, cleaned; without a usable name, `Update <file>`, `Update <a> and <b>`, or `Update <a> and N other files`. The Commit+Push subject is cleaned too. Review round 1 (`e66737d9`): `cleanTitle` masks credentials first, because the fallback is the user's first message and the title goes to GitHub as the PR title and the commit subject. Tests: `conversation-title.test.ts`, `pull-request-text.test.ts` (a token in the first message and in the name).
2. **Body** (`04897b21`, then `1405f45b`). Create PR reads GitHub's compare of the default branch and the session branch. It writes the body once: the commit subjects and a link `{AUTH_BASE_URL}/{org}/ws/{workspace}/{conversation}`, masked with `maskCredentials`. GitHub's Files tab lists the files, so the body does not. A failed compare gives the short body "Changes made in a ctx| conversation." and the link, so the PR still opens. The client cannot send a body.
   - **Later pushes: decision (team lead, review round 1).** A push does not change the body. A refresh on each push cost a database read, a PR read, a compare, two slug reads and an update. It repeated the Commits and Files tabs, could hold a push under rate limits, and could change text a person wrote. The first version (`04897b21`) had that refresh; `1405f45b` removed it.
   - Tests: `pull-request-text.test.ts` (format, masking) and a contract test in `conversation-branch-push-native.contract.test.ts` (msw on the GitHub API, with the fixture's compare served from the real remote): the created PR has the cleaned title, the commit subjects and the link; with a refused compare, the PR opens with the short body.
3. **Editor text** (`61dd3f5d`). Cause: `WorkspacePierreFile` showed `File` for a clean file and `FileDiff` as soon as the draft differed from the saved body. The first key in a clean file (a new file is empty) switched the view. The switch made a new editor without focus, so the next keys went nowhere. Reproduced in the static Storybook with real Playwright keys: with a 300 ms pause between keys, focus moved to `BODY` after the first key, and only one character was saved (as in run 2). Fix: an edit does not switch a plain file to a diff. A draft from an earlier visit opens as a diff. When a save or a revert leaves no change, the view is a plain file again (`04fb794c`; golden stories `DraftSavedShowsFile` and `DraftRevertedShowsFile`, which failed before that commit).
   - Test: golden story `NewFileKeepsTypedText` (`WorkspacePane.stories.tsx`). It creates a file, types, and saves. It checks that the editor element is the same, and that focus stays in it, after the first edit. It failed 3 of 3 times on the old code and passed 3 of 3 times with the fix. `userEvent.keyboard` cannot type into the editor's shadow DOM, so the story types through the editor handle. The real-key check was done by hand only.
   - Not covered: "type, then switch away" has no new test. The current `EditThenNavigate` story covers that path.
4. **Diff refresh** (`c944ecac`). `refreshConversationAfterTurn` (`queries.ts`, with the key `conversationGitDiffs`) marks as stale the Files tree, the status, the turn changes, and each Diff pane query (full and per turn) of the conversation when a turn ends. Test: `queries.test.ts` (the other conversation's diff stays fresh).

Red checks: the new contract test failed on the code before `04897b21` (temporary worktree with the old production files and the new test): `expected '"Add note one."\n\nMore text' to be 'Add note one'`.

Checks: backend publish tests (6 files, 74 tests) pass. Workspace golden stories (static build) pass. UI suite: 80 files, 440 tests pass; 8 jsdom files outside the workspace feature did not start, because `jsdom` is missing from this worktree's install. Biome and `test:policy` pass.
