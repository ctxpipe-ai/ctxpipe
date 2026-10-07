# Hosted (Vercel) chat sandboxes hold no credential

Status: in-progress
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

(open)
