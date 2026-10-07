# Self-host (Docker) sandboxes hold no credential, through Agent Vault

Status: review: Compose deploy and AWS deploy not run end to end
Priority: P0
Owner: claude
Blocked by: none
Created: 2026-10-08
Updated: 2026-10-08

## Context

A Docker chat sandbox (Compose and the AWS CDK sandbox host) gets credentials today. The clone token (`CTXPIPE_CLONE_TOKEN`), the Git run capability (`CTXPIPE_GIT_RUN_CAPABILITY`) for the `git-credentials` route, and the OpenCode run token (`CTXPIPE_OPENCODE_RUN_TOKEN`) are in its environment. The tool bridge token is in the OpenCode server environment. An agent can read each of them.

The user approved this decision: no credential of ours is ever inside a chat sandbox. Something outside the sandbox adds each credential in flight. For self-host, that is Agent Vault (Infisical, open source). The network stays open for HTTP(S): agents keep internet access through the proxy. Non-HTTP traffic from Docker sandboxes is blocked. A parallel ticket does the same for hosted (Vercel) sandboxes with the Vercel firewall.

## Plan

1. Compose: an `agent-vault` service (SQLite on a named volume, rate limits off, telemetry off, the proxy may dial only the backend's address on the `sandbox` network). A one-shot init service generates the master password and the owner password on a shared volume. The backend registers the owner on first use and logs in after that.
2. Forcing: rules in `scripts/sandbox-dind/entrypoint.sh` let containers inside DinD reach only Agent Vault's proxy port. No DNS: a proxied client does not resolve names.
3. Backend: an Agent Vault client (`@infisical/agent-vault-sdk`) and a per-run vault. The vault holds the GitHub token (Basic `x-access-token` for `github.com` and `codeload.github.com`, Bearer for `api.github.com`) and bearer rules for the model proxy and tool bridge paths. The sandbox gets only the proxy variables, the CA trust variables and placeholders. The turn end deletes the vault and revokes the GitHub token. The sweep deletes vaults that a turn end left. Chat fails closed with a clear error when Agent Vault is not reachable.
4. Remove the Docker credential paths: `CTXPIPE_CLONE_TOKEN`, `CTXPIPE_GIT_RUN_CAPABILITY`, the `git-credentials` route, `git-credential.mjs` and the `gh` wrapper.
5. Tests with real Docker and a real Agent Vault container.
6. AWS CDK: Agent Vault on the sandbox host, the owner password in Secrets Manager, DOCKER-USER rules. Changeset (minor).
7. ADR-048, ADR-049 and the self-hosting docs.

## Resolution

- `agent-vault.ts` (SDK `@infisical/agent-vault-sdk`) opens one vault per run with a proxy session. `docker-run-vault.ts` adds the run's GitHub read token (Workspace read scope). The turn adds exact-path rules for the model proxy and the tool bridge. The sandbox gets proxy and CA variables and placeholders only. The turn end and the prepare end delete the vault, then revoke the token. The sandbox sweep deletes old run vaults. No Agent Vault: 503 with a clear error.
- Workspace base builds clone through a run vault.
- Removed: the `git-credentials` route, `git-credential.mjs`, the `gh` wrapper, `CTXPIPE_CLONE_TOKEN` and `CTXPIPE_GIT_RUN_CAPABILITY` for Docker.
- Compose: `agent-vault`, `agent-vault-secrets`, fixed `sandbox` subnet, backend alias `backend.sandbox.ctxpipe.internal`; `agent-vault-dev` in the infra profile. `dind` lets sandboxes reach only the proxy (no DNS).
- CDK: Agent Vault on the sandbox host, two generated secrets, `DOCKER-USER` rules, backend callback at its VPC DNS name. Changeset (minor).
- Docker turns now get the open network policy and `webfetch` (after the merge of ticket 21).
- Proof: `agent-vault-native.contract.test.ts` (real Agent Vault: no credential in env, `/proc`, Git config; Git clone/fetch/push and HTTP get the credential; public HTTPS works; session ends with the vault; sweep; fail closed), `sandbox-dind-egress-native.contract.test.ts` (real DinD with our entrypoint: proxy only; failed without the rules), CDK synth tests, unit tests.

- Review fixes (three axes): one rule list for the firewall and Agent Vault (exact paths), one placeholder, no test-only branches in the chat path, owner registration only without an owner, login rate limit kept, split password volumes, host-dev API on 127.0.0.1 with a generated owner password, CDK allowlist of the backend subnets and no self-reach, deploy-set callback DNS suffix, IPv6 block in DinD, vault sweep once per window. New proof: `gh` through Agent Vault, a `..` path keeps the placeholder, the proxy cannot reach the management API, a tool-bridge turn in the Docker prepare test.

## Open

- Run `pnpm start` and a real AWS deploy end to end (not run).
- The two HTTPS-fixture Docker tests in `workspace-chat-prepare-native.contract.test.ts` need Linux `host-gateway` (CI); they do not run on Docker Desktop.
- Node `fetch` to a plain `http://` site fails through the proxy (HTTPS works).
