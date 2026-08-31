# Connect ctx| to Claude

1. Open Claude's MCP connections and connect **ctxpipe**.
2. Complete ctx| sign-in in the browser.
3. Confirm the organization shown on consent. For multi-organization accounts,
   use **Change organization** if it is not the intended one; ctx| shows the
   chooser first when no valid organization is active.
4. Return to Claude and call `ctx_advisor` with:

   ```text
   Connection check: name the ctx| organization available to this connection
   and one engineering standard or source area you can verify.
   ```

Setup is complete only when `ctx_advisor` returns organization context. A
successful OAuth redirect alone does not prove tool access.

## Claude Tag in Slack

Claude Tag channels are controlled by an organization Access bundle. An owner
must attach this plugin and add an **MCP Connector** credential for
`app.ctxpipe.ai`. This one-time admin connection is required by Claude Tag;
installing the community plugin cannot bypass it.

The selected ctx| organization is bound to that OAuth grant. Switching
organizations later in the admin's browser does not change what the Slack
agent can access. To use another organization, reconnect the MCP Connector and
select it during authorization.

Signing out of the ctx| browser session does not revoke an `offline_access`
grant. Disconnect the MCP Connector when its access should end.
