# Hosted (Vercel) chat sandboxes hold no credential

Status: review: the real Vercel lane runs in CI only
Priority: P0
Owner: claude
Blocked by: none
Created: 2026-10-08
Updated: 2026-10-08

## Context

A hosted chat sandbox must not hold a credential of ours: not in its environment, its files, its Git config, its process arguments, its OpenCode config, or `/proc`. Before this ticket, the Vercel firewall already added the GitHub read token. But each turn put the model-proxy capability (`CTXPIPE_OPENCODE_RUN_TOKEN`) into the sandbox environment, and the OpenCode server environment held the tool-bridge token. The firewall also limited egress to GitHub and the backend. Agents must have open internet access (documentation, packages).

The self-host (Docker) part is a separate ticket (Agent Vault). This ticket changes only the Vercel paths and the OpenCode config placeholder.

## Plan

1. One policy builder for hosted conversations and Workspace base builders: GitHub hosts with the GitHub token transform, the backend host with per-turn path rules (model proxy path and tool-bridge path, each with `Authorization: Bearer <credential>`), and `"*": []` so the rest of the internet stays open.
2. At turn start (the conversation lock is held), set the turn's model capability and bridge token in the firewall. At turn end (after the lock release, in the same order as the run Git tokens), remove them. A failed set fails the turn start with a clear error. A failed remove is logged; the next policy update replaces it, and the capability stops working when the lock is released.
3. The sandbox holds placeholders only: the OpenCode config `apiKey` and the bridge `Authorization` header are fixed placeholders. The hosted run environment gets no capability. Docker keeps its current path until the self-host ticket lands.
4. Tests: unit tests of the policy builder and of the turn firewall (msw for the Vercel API), the hosted run environment and OpenCode config without a credential, and the real Vercel contract lane.
5. Update ADR-048 and the docs about hosted sandbox credentials and egress.

## Resolution

- `hostedNetworkPolicy` (vercel-sandbox-provider.ts) is the one policy builder for conversations and Workspace base builders. It has GitHub hosts with the read token and `"*": []` last. During a turn, it also has the backend host with two rules: the bridge path (exact match) and the two model proxy paths (anchored regular expression). Each rule sets the `Authorization` header and pins the `Host` header.
- `conversationFirewall` keeps the GitHub token and the turn's rules per sandbox in the process, and it sends one update at a time. A GitHub token rotation from any chat call keeps the turn's rules.
  - `openTurn` runs in the permissions setup (lock held, before OpenCode). If it fails, the turn fails with "Setting the sandbox firewall for this turn failed".
  - `closeTurn` runs before the lock release, also after a failed `openTurn`. A failed close is logged.
- The hosted run environment gets no capability. The hosted OpenCode `apiKey` and the bridge token that OpenCode gets are `WORKSPACE_CHAT_FIREWALL_PLACEHOLDER`. The bridge id and token are set before the run.
- Each turn gets a new random OpenCode password (`turnAgentPassword`), on Docker and Vercel. The server must hold it, so it is in the sandbox, but it opens nothing after the turn.
- A hosted agent can read the web: OpenCode `webfetch` is allowed, and the tool policy does not refuse a public host (`openNetwork`). The cloud metadata address stays refused. Web search stays off: it uses OpenCode's own search service.
- The model proxy and bridge routes do not check for dot segments: Bun resolves `..` and `%2e` before routing (measured), so a route cannot see them. The exact firewall matchers are the check.
- ADR-048, the Workspaces PRD and the Workspace chat docs say that hosted egress is open and that the firewall adds every credential.

Proof (each failed before its change):

- `vercel-sandbox-provider.test.ts`: the policy (rules, pinned host, exact paths, dot segments, catch-all last), the firewall with msw for the Vercel API (open, rotation from another call, close, failed open, applied-then-failed open, not attached), and `turnAgentPassword`.
- `workspace-chat-run-capabilities.test.ts`: the hosted run environment is empty.
- `workspace-chat-opencode-contract.test.ts`: the hosted config has the placeholder key and allows `webfetch`.
- `chat-sandbox-policy.test.ts`: with an open network, a curl to a public host is allowed and the metadata address is refused.
- `workspace-chat-callback.test.ts`: the bridge gives OpenCode the placeholder. The route answers 401 to the placeholder, 200 to the real token, and 401 after the bridge closes.
- `docker-agent-port-native.contract.test.ts` (run locally): the next turn's server refuses the earlier turn's password.
- `vercel-sandbox.contract.test.ts` (CI lane only), "hosted turn credentials": an echo host stands in for the backend. It checks the credentials on exact paths only, the pinned host, no credential inside (environment, `/proc`, Git config, files), no credential after `closeTurn`, and that `https://example.com` answers 200.

## Open

- Proved on the pr-280 preview, not in CI: a full hosted turn with a tool call, and a 401 from the real backend after the turn ends. Manual check:
  1. On the preview, open a Workspace chat and send "Use the ctxpipe search tool to find the README, then reply with its first line".
  2. Make sure that the reply uses the tool and that the turn finishes.
  3. While the turn runs, ask the agent in a second message to run `env` and `cat /proc/*/environ`. Make sure that no `CTXPIPE_OPENCODE_RUN_TOKEN` and no bridge token are in the output.
  4. After the turn ends, ask the agent to run `curl -s -o /dev/null -w '%{http_code}' -X POST <preview origin>/<org>/api/v1/workspace-chat/openai/v1/chat/completions`. Make sure that the answer is 401. (That command runs in the next turn, so the result shows that the earlier turn's capability is gone. The current turn's rule adds the current capability, thus send it to the bridge path of the earlier turn instead if the model path answers 200.)
  5. Ask the agent to fetch `https://example.com` with `webfetch`. Make sure that it works.
- Known debt: the contract lane uses an in-memory `SandboxGitTokenStore` and depends on httpbin.org as the echo host.
- Known limit: a GitHub token rotation that another backend process started can remove a running turn's rules.
