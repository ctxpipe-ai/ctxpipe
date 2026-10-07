# Self-host (Docker) sandboxes hold no credential, through Agent Vault

Status: in-progress
Priority: P0
Owner: claude
Blocked by: none
Created: 2026-10-08
Updated: 2026-10-08

## Context

A Docker chat sandbox (Compose and the AWS CDK sandbox host) gets credentials today. The clone token (`CTXPIPE_CLONE_TOKEN`), the Git run capability (`CTXPIPE_GIT_RUN_CAPABILITY`) for the `git-credentials` route, and the OpenCode run token (`CTXPIPE_OPENCODE_RUN_TOKEN`) are in its environment. The tool bridge token is in the OpenCode server environment. An agent can read each of them.

The user approved this decision: no credential of ours is ever inside a chat sandbox. Something outside the sandbox adds each credential in flight. For self-host, that is Agent Vault (Infisical, open source). The network stays open for HTTP(S): agents keep internet access through the proxy. Non-HTTP traffic from Docker sandboxes is blocked. Ticket 21 (Part A) does the same for hosted (Vercel) sandboxes with the Vercel firewall.

## Plan

1. Compose: an `agent-vault` service (SQLite on a named volume, rate limits off, telemetry off, the proxy may dial only the backend's address on the `sandbox` network). A one-shot init service generates the master password and the owner password on a shared volume. The backend registers the owner on first use and logs in after that.
2. Forcing: rules in `scripts/sandbox-dind/entrypoint.sh` let containers inside DinD reach only Agent Vault's proxy port. No DNS: a proxied client does not resolve names.
3. Backend: an Agent Vault client (`@infisical/agent-vault-sdk`) and a per-run vault. The vault holds the GitHub token (Basic `x-access-token` for `github.com` and `codeload.github.com`, Bearer for `api.github.com`) and bearer rules for the model proxy and tool bridge paths. The sandbox gets only the proxy variables, the CA trust variables and placeholders. The turn end deletes the vault and revokes the GitHub token. The sweep deletes vaults that a turn end left. Chat fails closed with a clear error when Agent Vault is not reachable.
4. Remove the Docker credential paths: `CTXPIPE_CLONE_TOKEN`, `CTXPIPE_GIT_RUN_CAPABILITY`, the `git-credentials` route, `git-credential.mjs` and the `gh` wrapper.
5. Tests with real Docker and a real Agent Vault container.
6. AWS CDK: Agent Vault on the sandbox host, the owner password in Secrets Manager, DOCKER-USER rules. Changeset (minor).
7. ADR-048, ADR-049 and the self-hosting docs.

## Resolution

Open.
