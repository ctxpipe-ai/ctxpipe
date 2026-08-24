# Workspace chat answer latency

Status: accepted (2026-08-24)

Workspace chat must feel interactive. A typical inventory question must not sit in a
30–45s tool/serve loop.

## Requirements

- **SLO:** For `what's in this repo?` on the product UI path (workspace open, compose
  mounted, then Send), the complete useful assistant answer must land in **about 5
  seconds** (not first-token only).
- **Same lock:** TanStack `chat()` + `withSandbox` + `opencodeText`, one sandbox per
  conversation, configured `MODEL_FAST_NAME` / `MEDIUM` / `HIGH` only through the
  app proxy. See [workspace-chat-sandboxes](workspace-chat-sandboxes.md) and
  [workspace-chat-models](workspace-chat-models.md).

## Not this document

How to hit the SLO (GitHub skip, proxy reuse, inventory, in-sandbox serve
keep-alive, compose pre-warm) belongs in the working plan, not here.
