# CTX-532: Pass the codesearch Git credential per command

Status: done on the branch `fix/codesearch-clone-credentials`.

## Change

- `apps/codesearch/src/utils/git.ts`: `credentialFreeGitUrl` gives the remote
  URL without a user name or password. `gitCommandEnv` gives the GitHub token
  to each Git command through an inline `credential.helper` that reads the
  environment of the Git process. The helper applies only to the scheme and
  host of the remote. The command clears the other helpers and `GIT_ASKPASS`,
  and Git does not prompt. The backend sandbox uses the same method
  (`SANDBOX_READ_GIT` in `chat-runtime.ts`).
- Clone, fetch, deepen, unshallow and `ls-remote` use the plain remote URL and
  that environment. Each fetch sets the plain remote URL again.

## Tests

`apps/codesearch/src/domain/indexing/phases.credentials.test.ts` (Bun runtime)
uses a real `git http-backend` remote behind a local proxy. It checks that:

- a clone and a fetch keep `.git/config` free of the token;
- an error does not contain the token;
- a redirect on the same host works;
- a redirect to another host does not get the token.
