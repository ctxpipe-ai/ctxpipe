# CTX-584 risk spikes: closed egress (T03) and run-scoped Git refs (T08)

Date: 2026-10-13. Both spikes pass. T03 and T08 can continue.

## T03: Agent Vault refuses other hosts

**Result: it works.** Agent Vault has a per-vault setting,
`unmatched_host_policy`, with the values `passthrough` (the default) and `deny`.
The API is `PATCH /v1/vaults/{name}/settings`. The SDK (0.7.0) has no method
for it, so `openRunVault` calls the API directly. With `deny`, the proxy
returns `403` for each request that no service matches.

Change: `openRunVault({ …, unmatchedHosts: "deny" })` sets the policy after it
creates the vault and before it creates the session. Chat vaults do not set
it, so chat keeps open internet access.

Contract test (Docker, real `infisical/agent-vault:latest`):
`apps/backend/src/domain/workspaces/agent-vault-native.contract.test.ts`,
"a closed vault forwards only its rules". The fixture option `closed: true`
puts the sandbox on an internal Docker network where Agent Vault is the only
other container. This is the same as the iptables rules of the DinD host
(`scripts/sandbox-dind/entrypoint.sh`) and the AWS sandbox host.

Evidence (one run, all four tests in the file pass):

| Request from the sandbox | Result |
| --- | --- |
| Model proxy path (rule) | forwarded, `Authorization: Bearer <capability>` added |
| Tool bridge path (rule) | forwarded, Bearer token added |
| `git ls-remote` on the Git rule paths | `refs/heads/main` listed |
| `https://api.github.com/user` (GitHub rule, fake token) | GitHub answers `Bad credentials` (so the proxy forwarded it) |
| `https://example.com/`, `http://example.com/` | `403` from Agent Vault |
| Other path on the model proxy host | `403` |
| `git-receive-pack` (push path, no rule) | `403` (before the change: `401` from the upstream) |
| `--noproxy` to `example.com` and to `1.1.1.1` | `000` (no route, no DNS) |

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
  `/chat/completions`). The GitHub rules are host-wide, so all GitHub paths
  pass, and push paths too. The read-only token is the control for writes.
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
