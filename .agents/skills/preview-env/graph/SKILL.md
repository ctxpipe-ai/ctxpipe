---
name: preview-env-graph
description: Workspace Graph pane (Cosmograph): canvas, node detail, and direct-URL reload (preview-env).
disable-model-invocation: true
---

# preview-env graph

This Workspace's projection, not an org-wide graph. Hydrate must be `ready` ([HYD-1](../hydrate/SKILL.md)). [Harness](../harness.md) is `PASS`. Flow format: [run-setup](../run-setup.md#flow-format).

### GRAPH-1 Pane loads
**Requires** HYD-1.
**Steps**
1. Open `{BASE_URL}/{orgSlug}/ws/{workspace1Slug}?pane=graph` (the composer URL is enough).

**Expect (UI)** `pane=graph` in the URL, the **Graph** tab selected, and a painted canvas (nodes and edges) or an honest empty state. Empty after `ready` with no "derived graph unavailable" copy is a `PASS` (sparse projection). The copy **derived graph unavailable** is a `FAIL`.
**Expect (backend)** `GET /{orgSlug}/api/v1/workspaces/{workspace1Slug}/graph` returns 200 (503 is a FAIL: the graph store or projection is down); the projection has 4 `WorkspaceKnowledgeUnit` nodes and 11 `WorkspaceSignal` edges, told apart by their `predicate` property: 7 `LINKS_TO` from the template's relative links and 4 claim edges (`DEPENDS_ON`, `IMPLEMENTED_IN`, `OWNS`, `PART_OF`). Edges are not typed relationships named after the predicate.
**Budget** 3 s / 10 s, pane open to canvas painted.
**Evidence** `GRAPH-1-1.png`; HTTP status; trace of the graph request.

### GRAPH-2 Select a node
**Requires** GRAPH-1 with at least one node (else `SKIP(no-fixture)`).
**Steps**
1. Click a node.
2. If the inspector offers a source path, open it.

**Expect (UI)** an inspector or drawer shows a label; the source path opens **Files** (`pane=file:…` or `pane=files`). If the URL gains `?node=`, it stays.
**Expect (backend)** none beyond the graph GET.
**Budget** 1 s / 3 s, click to inspector.
**Evidence** `GRAPH-2-1.png`.

### GRAPH-3 Reload on the graph URL
**Requires** GRAPH-1.
**Steps**
1. With `pane=graph` in the address bar, hard-reload; then open the same URL in a new tab.

**Expect (UI)** the shell renders, the Graph pane mounts, and no blank page or crash screen appears (the canvas is client-only; server rendering must not break). The browser console has no uncaught error from the pane.
**Expect (backend)** the document request returns 200; the graph GET follows once.
**Budget** 5 s / 15 s, reload to canvas or empty state.
**Evidence** `GRAPH-3-1.png`; console excerpt on failure.

## Status

- **PASS** GRAPH-1 and GRAPH-3 `PASS`; GRAPH-2 `PASS` or `SKIP`.
- **FAIL** 503 or "derived graph unavailable" after a ready hydrate, the pane never mounting, or a crash on reload.
- **SKIP** hydrate not ready (say so; do not pretend the graph works).
