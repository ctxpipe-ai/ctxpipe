---
name: preview-env-graph
description: Knowledge graph pane on a Railway PR preview workspace.
disable-model-invocation: true
---

# preview-env graph

Workspace Graph pane (Cosmograph). Hydrate should already be `ready` ([hydrate](../hydrate/SKILL.md)). [Harness](../harness.md) is `PASS`. One `computerUse` task.

## 1. Open

Go to `{BASE_URL}/{orgSlug}/ws/{workspaceSlug}?pane=graph` (compose URL is enough).

**Done when:** `pane=graph` is in the URL and the Graph tab is selected.

## 2. Canvas

The pane shows a graph canvas (nodes/edges) **or** an explicit empty/error state.

- Empty after `hydrateStatus === "ready"` with no “derived graph unavailable” → PASS (sparse projection).
- Copy **derived graph unavailable** or HTTP 503 on `GET /{orgSlug}/api/v1/workspaces/{workspaceSlug}/graph` → FAIL (FalkorDB / projection).

**Done when:** either a canvas is painted or the empty/error copy is recorded with the GET status.

## 3. Select a node

If any node is visible: click it. An inspector or drawer shows a label. If a source path is offered, open it and land on Files (`pane=file:…` or `pane=files`).

Optional: if the URL gains `?node=`, keep it.

**Done when:** a node was selected and the inspector rendered, **or** the canvas is empty (SKIP this step).

## Status

- **PASS** — pane opened; canvas or honest empty; select worked when nodes exist.
- **FAIL** — 503 / “derived graph unavailable” after ready hydrate, or the pane never mounts.
- **SKIP** — hydrate not ready (say so; do not pretend graph works).
