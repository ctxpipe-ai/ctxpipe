# CTX-584 risk spikes: closed egress (T03) and run-scoped Git refs (T08)

Date: 2026-10-13. Both spikes pass. T03 and T08 can continue.

## T03: Agent Vault refuses other hosts

**Result: it works.** Agent Vault has a per-vault setting,
`unmatched_host_policy`, with the values `passthrough` (the default) and `deny`.
The API is `PATCH /v1/vaults/{name}/settings`. The SDK (0.7.0) has no method
for it, so `openRunVault` calls the API directly. With `deny`, the proxy
returns `403` for each request that no service matches.

Change: `openRunVault({ …, unmatchedHosts: "deny" })` sets the policy and the
rules before it creates the session. It reads the policy back from the
settings answer and throws `AgentVaultUnavailableError` when the answer does
not confirm `deny`. A failure deletes the vault. Chat vaults do not set the
policy, so chat keeps open internet access.

The sandbox never pushes: the host pushes ingest refs through the broker
(ADR-052). An ingest vault gets `githubFetchCredentialRules`: only
`/<owner>/<name>.git/info/refs` and `/<owner>/<name>.git/git-upload-pack` per
repository. It has no rule for `git-receive-pack`, `codeload.github.com`, or
`api.github.com`. Agent Vault matches the path without the query, so the
`info/refs` rule also forwards `?service=git-receive-pack`. That call only
lists refs; the push itself (`git-receive-pack`) gets `403`.

Contract test (Docker, real `infisical/agent-vault:latest`):
`apps/backend/src/domain/workspaces/agent-vault-native.contract.test.ts`,
"a closed vault forwards only its rules". The fixture option `closed: true`
puts the sandbox on an internal Docker network. There, a TCP forwarder gives
access only to the proxy port of Agent Vault, not to its API. This is the
same as the iptables rules of the DinD host (`scripts/sandbox-dind/entrypoint.sh`)
and the AWS sandbox host.

Evidence (one run, all four tests in the file pass):

| Request from the sandbox | Result |
| --- | --- |
| Model proxy path (rule) | forwarded, `Authorization: Bearer <capability>` added |
| Tool bridge path (rule) | forwarded, Bearer token added |
| `git clone` with the fetch rules | the clone works |
| `git push` to the test Git server (the token can push there) | refused, `403` from Agent Vault |
| github.com `info/refs?service=git-upload-pack` (fake token) | `401` from GitHub (so the proxy forwarded it) |
| github.com `git-receive-pack`, `api.github.com` read and write | `403` |
| `https://example.com/`, `http://example.com/` | `403` from Agent Vault |
| Other path on the model proxy host | `403` |
| Agent Vault API through the proxy | `403` |
| Agent Vault API port directly (`--noproxy`) | `000` (not open to the sandbox) |
| `PATCH …/settings` on the proxy port with the session token | not `2xx` |
| `PATCH …/settings` and `PUT …/services` with the session token, from the host | `401` or `403`; `example.com` still `403` after |
| `--noproxy` to `example.com` and to `1.1.1.1` | `000` (no route, no DNS) |

Unit test (`agent-vault.test.ts`, msw): a settings answer of `200` that keeps
`passthrough`, and a `500`, both throw `AgentVaultUnavailableError`, delete
the vault, and start no session.

Before the change, `example.com` and the other path returned `200` (red step).

Limits and follow-ups for T03:

- Agent Vault filters by host and exact path. It cannot stop a direct
  connection. The sandbox host must force all traffic through the proxy.
  DinD (`deploy` profile) and AWS do that. **Host dev (`agent-vault-dev` in
  the `infra` profile) does not**: there, an ingest sandbox can bypass the
  proxy. Run ingest on host dev only for development, or put ingest sandboxes
  on an internal Docker network (as the test fixture does).
- Exact-path rules: with `deny`, the bridge and model proxy rules must list
  every path that the sandbox calls (for example `/models` and
  `/chat/completions`). The sandbox must use `https://github.com/<owner>/<name>.git`
  URLs (with `.git`), as the fetch rules match that path only.
- The hosted (Vercel) side is separate: `hostedNetworkPolicy` ends with
  `"*": []`, which keeps the internet open. For ingest, T03 must omit `"*"`.
  This spike did not test the Vercel firewall.

## T08: GitHub accepts custom refs

**Result: it works.** Test on a throwaway private repository `ctxpipe-ai/pe-<timestamp>-refs`
that this spike created and then deleted. Credential: a user token with the
`repo` scope (the GitHub CLI login), **not** the GitHub App installation
token. No App private key was available here. GitHub applies the same ref
rules to both token kinds (only `refs/pull/*` is reserved), but the App
proof is still open: do it once at the start of T08 on a preview.

Evidence (`git push --porcelain` output):

| Step | Result |
| --- | --- |
| Create `refs/ctxpipe/ingest/spike-<hex>/ws-1` with `--force-with-lease=<ref>:` (must not exist) | `[new reference]` |
| Advance with `--force-with-lease=<ref>:<old tip>` (fast-forward) | accepted |
| Push a rival commit with a stale old tip | `[rejected] (stale info)` |
| Push the rival commit with no lease and no force | `[rejected] (non-fast-forward)` |
| `git ls-remote` | lists the ref next to `HEAD` and `refs/heads/main` |
| Default `git clone` | only `refs/heads/main` and `refs/remotes/origin/*`; the step commit is not in the clone |
| `git fetch origin <ref>` | `FETCH_HEAD` is the step commit |
| `git push origin :<ref>` | `[deleted]`; `ls-remote 'refs/ctxpipe/*'` is empty |
| Default branch | unchanged |

Follow-ups for T08:

- Every push to GitHub, also to `refs/ctxpipe/…`, sends a `push` webhook.
  `processPushEvent` (`routes/webhooks/github/github.ts`) enqueues a
  Workspace tip check for each push before its default-branch gate. Ingestion
  starts only for default-branch pushes. Thus each step push enqueues one tip
  check. T08 should return early for `refs/ctxpipe/` in that handler and add
  a test for it.
- `git clone --mirror` and `fetch` with a `refs/*` refspec do get these refs.
  Tools that mirror the repository see in-flight runs until the clean-up.
