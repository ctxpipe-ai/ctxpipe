---
"@ctxpipe/aws-cdk": minor
---

The public MCP server at `/mcp` has new read-only tools: `list_workspaces`, `search_knowledge`, `search_code`, `find_symbol`, `read_file`, `list_files`, and `get_related`. The tool `ctx_advisor` is removed, so an MCP client that calls it must call the new tools. Each tool call names one organization with the `org` argument. An OAuth grant holds a set of organizations, and the user changes the set on the new Connected apps page. The server ignores the `?orgSlug=` URL parameter. The scopes are `ctxpipe:read` and `ctxpipe:write`.

Upgrade: there are no new required props. Run `pnpm update @ctxpipe/aws-cdk`, then `cdk deploy`. The release runs database migrations for the organization sets and the knowledge search tables.
