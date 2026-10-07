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

- `hostedNetworkPolicy` (vercel-sandbox-provider.ts) is the one policy builder for conversations and Workspace base builders: GitHub hosts with the read token, the backend host with the turn's path rules (bridge path exact, first; model proxy path prefix), and `"*": []` last.
- `conversationFirewall` keeps the GitHub token and the turn's rules for one chat call and sends one update at a time. A GitHub token rotation keeps the turn's rules. `openTurn` runs in the permissions setup (lock held, before OpenCode). `closeTurn` runs in the run-token middleware, after the lock release. A failed open fails the turn with "Setting the sandbox firewall for this turn failed"; a failed close is logged.
- The hosted run environment gets no capability (`workspaceChatRunCapabilities("vercel")` is `{}`). The hosted OpenCode config `apiKey` and the bridge token that OpenCode gets are `WORKSPACE_CHAT_FIREWALL_PLACEHOLDER`. The bridge id and token are set before the run (`publicRouteBridgeProvisioner(publicBaseUrl, bridge)`). Docker and unsandboxed are unchanged.
- ADR-048 and the Workspace chat docs say that hosted egress is open and that the firewall adds every credential.

Proof (each failed before the change):

- `vercel-sandbox-provider.test.ts`: the policy rules, their order and the catch-all; the firewall with msw for the Vercel API (open, rotate during a turn, close; a failed open keeps no turn).
- `workspace-chat-run-capabilities.test.ts`: the hosted run environment is empty.
- `workspace-chat-opencode-contract.test.ts`: the hosted OpenCode config has the placeholder key.
- `workspace-chat-callback.test.ts`: the bridge gives OpenCode the placeholder; the route answers 401 to the placeholder and 200 to the real token, and 401 after the bridge closes.
- `vercel-sandbox.contract.test.ts` (CI lane only), "hosted turn credentials": an echo host stands in for the backend. The turn's headers are added by path, no credential is in the environment, `/proc`, the Git config or the files, the headers are gone after `closeTurn`, and `https://example.com` answers 200. The agent snapshot and base tests now expect the npm registry to be reachable.

## Open

- The contract lane has no public backend, thus a full turn with a tool call and a 401 from the real backend after turn end are not proven against Vercel. The preview (pr-280) can prove them.
- `chat-sandbox-policy.ts` still refuses hosts in the agent's command policy (`host_not_allowlisted`) and the OpenCode config denies web tools. The network is open, but those agent rules are not changed by this ticket.
