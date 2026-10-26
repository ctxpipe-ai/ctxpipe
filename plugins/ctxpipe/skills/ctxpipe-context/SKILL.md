---
name: ctxpipe-context
description: Use the ctxpipe MCP read tools to find organization knowledge, ADRs, standards, owners, and code in linked repositories before you plan or change code. Use when a task may depend on an organization decision, a service owner, or code in another repository.
---

# ctxpipe context

The ctxpipe MCP server gives you facts with stable refs. You do the reasoning. The server runs no model for a call. Do not invent organization standards from the local repository alone.

## Rules

- ctxpipe serves the default branch of each linked repository. Do not use it to read the repository that you work in. Use your own file tools for that repository.
- Name the organization in `org` on every call except `list_workspaces`. One call uses one organization.
- Send independent calls in parallel.
- Cite the `ref` of each fact that you use. Say "unverified" for a claim that has no ref.
- Never put tokens or secrets in a query.
- For a question about ctxpipe itself (setup, Workspaces, connections, MCP clients, self-hosting), read `https://docs.ctxpipe.ai/llms.txt`, then the page that matches. The tools serve organization context, not the ctxpipe docs.

## Start

1. Call `list_workspaces`. Without `org`, it lists each organization that this connection can read, with the Workspace slugs. Use the slugs in the next calls.
2. To see the repositories, sources, and readiness of one Workspace, call `list_workspaces` with `org` and `workspace`.
3. If a call returns `org_not_found`, the connection cannot read that organization. Do not guess another slug. Tell the user to add the organization in ctxpipe under **Connected apps**.

## The seven tools

| Tool | Use it to |
| -- | -- |
| `list_workspaces` | Find the organizations and Workspaces you can read, and the state of one Workspace. |
| `search_knowledge` | Search knowledge units (ADRs, standards, service pages, mirrored issues, docs) in natural language or with keywords. Filter with `kinds`, `pathPrefix`, `sources`, `updatedAfter`, `validAt`. Omit `workspaces` to search all Workspaces of the organization. |
| `get_related` | Find units near seed refs in the graph and relevant to a `query`. Set `intent`: `general` (the default), `why`, `ownership`, `change`, `dependencies`, `structure`, or `provenance` (the sources that a unit came from). Use `excludePredicates` and `excludeKinds` to remove edges and result kinds. Each intent has its own default walk of the graph, so pick the intent that matches your question. Use it after `search_knowledge` for owners, dependencies, decisions, changes, and sources. |
| `search_code` | Search linked repositories. `mode` is `literal`, `regex` (RE2), or `structural` (ast-grep, needs `language`). Narrow it with `pathGlob` (a gitignore-style glob, such as `*.ts`) and `caseSensitive`. |
| `find_symbol` | Find the `definition`, `references`, `callers`, or `callees` of a symbol. |
| `list_files` | List one folder of the Workspace repository or of a linked repository. Set `depth` (1 to 5) for more levels, or `glob` to list only matching files. |
| `read_file` | Read a unit or a repository file by ref, with a line range. |

## Work loop

1. Before a design choice, call `search_knowledge` with the task and the subsystem. Read the best hits with `read_file`.
2. Call `get_related` with the refs of the best hits to find the owner, the dependencies, and the decisions that touch them.
3. For code in other repositories, call `search_code` or `find_symbol`. Then call `read_file` with the returned ref.
4. Compare the facts with the local repository. Say what the facts support and what you could not verify.

## Refs

- A knowledge unit ref is its path in the Workspace repository, for example `knowledge/services/payments-api.md`. `read_file` needs `workspace` for it.
- A repository file ref is `<handle>:<path>`, for example `example/payments-api:src/limits.ts`. The handle is `owner/name`.
- A ref is relative to the `org` and `workspace` of the call. Use it with the same values.
- A client that supports MCP resources can also open `ctxpipe://{org}/{workspace}/{+ref}`, for example `ctxpipe://acme/platform/knowledge/services/payments-api.md`. Prefer `read_file` for work that you drive yourself. The resource is for `@`-mention.

## Exclude your repository

`search_code` and `find_symbol` need `excludeRepositories`. Put the handle or git URL of the repository you work in there. Use `[]` when you work in no linked repository. The other tools accept it too. `read_file` refuses an excluded repository with `excluded_repository`.

## Pages and limits

- A result can have a `cursor`. Send it back with the same arguments for the next page. After a change of the served commit, the server returns `stale_cursor`: start the search again.
- `truncated: true` means the server cut the result to fit its size limit. Narrow the query instead of paging through noise.
- A `skipped` list names Workspaces or repositories that the server did not search, with a reason. Narrow the call with `workspace` or `repositories` when a repository is skipped as `over_limit`.
- Each result states the served branch and commit. Use it when you tell the user how fresh a fact is.
- An error has `code`, `message`, and `retryable`. Retry only when `retryable` is true.

## Answer

State the facts you found, each with its ref. Separate verified facts from inference. Do not cite line numbers or call paths that no tool result in this conversation supports.
