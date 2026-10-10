# Self-host (Docker) sandboxes hold no credential, through Agent Vault

Status: review: Compose deploy passed end to end without codesearch; push credential injection not tested end to end (the contract test covers it); AWS deploy waits for an AWS login
Priority: P0
Owner: claude
Blocked by: none
Created: 2026-10-08
Updated: 2026-10-10

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

- Compose end to end (2026-10-10), deploy profile from a clean project with its own name and ports, without `codesearch` (the Docker disk was full): registration, an organization, a Workspace from a pasted public repository URL (read-only, because a self-host GitHub App needs a public HTTPS URL), and chat turns with the bash tool.
  - Pass: a tool call ran in the sandbox; the model calls went through Agent Vault; `curl https://example.com` and `curl http://example.com` gave 200; `git ls-remote` on a public repository worked.
  - Pass: direct TCP from the sandbox (ports 22, 53, 80 and 443) is blocked.
  - Pass: no model key or GitHub token in the sandbox: a scan of each process environment, each command line and the files outside `/usr` found no model key and no GitHub token pattern. `GH_TOKEN` and the OpenCode `apiKey` hold the placeholder.
  - Pass: with Agent Vault stopped, `prepare` answers 503 with the clear error and no sandbox starts. The streamed turn answers HTTP 200 with a `RUN_ERROR` event that holds the same error (the stream starts first). After a restart of Agent Vault, `prepare` answers 204.
  - Push credential: not run in Compose (no GitHub App). `agent-vault-native.contract.test.ts` passed again (Git push, HTTP and `gh` get the credential through a real Agent Vault).
  - Fixes: the UI image build ran out of Node heap on an 8 GB Docker VM; the model provider settings did not reach the backend and the worker; the chat image build in DinD could not download, because the DinD rules block the bridge (now `--network host`, with a contract test step). Review round 1: empty model settings are unset in the model provider, Compose passes every model setting, and the DinD entrypoint blocks instance metadata for the host-network build.

## Open

- Run a real AWS deploy end to end: waits for an AWS login (`ctxpipe-sandbox` SSO session expired).
- The two HTTPS-fixture Docker tests in `workspace-chat-prepare-native.contract.test.ts` need Linux `host-gateway` (CI); they do not run on Docker Desktop.
- Node `fetch` to a plain `http://` site fails through the proxy (HTTPS works).
