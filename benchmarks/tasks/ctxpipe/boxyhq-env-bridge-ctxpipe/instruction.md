# BoxyHQ Env Bridge (ctxpipe MCP)

You are integrating the SaaS Starter Kit with a standalone Ory Polis deployment
(not embedded Jackson).

**There is no repository checkout in this workspace.** Use the **ctxpipe** MCP
server (already configured for your trial) to read org code context for:

- `boxyhq/saas-starter-kit` (primary)
- `ory/polis`
- `boxyhq/ui`

Write `/app/answer.json` with exactly these keys:

- `jackson_url_env`
- `jackson_external_url_env`
- `jackson_api_key_env`
- `polis_saml_path_prefix`
- `polis_saml_path_source_file`

Use string values only.

For the three `jackson_*` keys, return the environment variable names used by
the starter kit for external Jackson/Polis configuration.

For `polis_saml_path_prefix`, return the default SAML HTTP path prefix used by
Polis.

For `polis_saml_path_source_file`, return the source file path (inside the
Polis repository) where that path prefix constant is defined.
