# Connect ctxpipe to Claude

1. Open Claude's MCP connections and connect **ctxpipe**.
2. Complete ctxpipe sign-in in the browser.
3. On the consent page, tick the organizations that Claude may read. The
   organization of your current session is ticked. Tick at least one. Edit the
   set later on **Connected apps**.
4. Return to Claude and call `list_workspaces` with no arguments.

Setup is complete only when `list_workspaces` lists at least one organization
and its Workspaces. A successful OAuth redirect alone does not prove tool
access. An empty list means the connection has no organization: reconnect and
tick an organization on the consent page. Then call `search_knowledge` with an
`org` and a short query to confirm that search works.

The plugin also installs the `ctxpipe-context` skill. It teaches Claude the
seven read tools: `list_workspaces`, `search_knowledge`, `get_related`,
`search_code`, `find_symbol`, `list_files`, and `read_file`.

## Claude Tag in Slack

Claude Tag channels are controlled by an organization Access bundle. An owner
must attach this plugin and add an **MCP Connector** credential for
`app.ctxpipe.ai`. This one-time admin connection is required by Claude Tag;
installing the community plugin cannot bypass it.

The OAuth grant holds a set of ctxpipe organizations that the admin ticks on the
consent page. Switching organizations later in the admin's browser does not
change what the Slack agent can access. To add an organization, open
**Connected apps** in ctxpipe settings and tick it, or reconnect the MCP Connector.

Signing out of the ctxpipe browser session does not revoke an `offline_access`
grant. Disconnect the MCP Connector when its access should end.
