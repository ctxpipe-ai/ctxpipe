# GitHub App: in-product repository create

Facts for [Project repository create, select, relink, and import](../issues/09-project-repository-lifecycle.md). Not a product decision.

Sources: [Permissions required for GitHub Apps](https://docs.github.com/en/rest/authentication/permissions-required-for-github-apps) (Repository permissions for “Administration”), [Create an organization repository](https://docs.github.com/en/rest/repos/repos#create-an-organization-repository).

## What GitHub allows

| Call | Who can auth | GitHub App permission |
| --- | --- | --- |
| `POST /orgs/{org}/repos` | Installation token (IAT) or user-to-server token (UAT) | Repository **Administration: write** |
| `POST /user/repos` (user-owned account) | **UAT only** | Repository **Administration: write** |

There is **no** narrower App permission that only creates a repo. The same Administration:write grant also covers `DELETE /repos/{owner}/{repo}`, visibility/settings patches, and (UAT) transfer.

`Contents: write` (what we use today for `createOrUpdateFileContents`) cannot create the repository.

## What ctxpipe has today

- Tokens: **installation tokens only** (`getInstallationToken` → `octokit.auth({ type: "installation" })`). No user-to-server GitHub token mint for this App.
- Create UX: external [`github.com/new`](https://github.com/new) links (`ConnectorContextRepositoryGuidance`), then select from installation-accessible repos.
- No `repos.create` / `createInOrg` in the backend.

## Practical constraints

- **GitHub organization install:** IAT + Administration:write can create the repo in that org without sending the user to `github.com/new`. Existing App installations must **accept the new permission**.
- **User-account install:** `POST /user/repos` is UAT-only. IAT cannot create a repo under a user account. Without adding user-to-server OAuth, that install shape keeps an external create (or we refuse in-product create).
- **Selected-repositories installs:** a newly created repo is not automatically in the installation. “All repositories” installs see new repos immediately.
