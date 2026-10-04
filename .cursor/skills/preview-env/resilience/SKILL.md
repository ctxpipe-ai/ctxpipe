---
name: preview-env-resilience
description: Backend restart mid-chat, worker sleep and wake, and inline errors instead of blank pages (preview-env).
disable-model-invocation: true
---

# preview-env resilience

Last area: it disturbs the target. [Harness](../harness.md) is `PASS`; run it after the other areas. Flow format: [run-setup](../run-setup.md#flow-format).

### RES-1 Backend restart mid-chat (`gated-restart-ok`)
**Requires** flag `restart-ok` (a human or the run may restart the backend: `local` stop and start `pnpm dev`; `preview` Railway `restart-service` or redeploy of the backend, allowed on `pr-280` only per the [write policy](../run-setup.md#write-policy)); CHAT-2.
**Steps**
1. Send a long-answer prompt in the Workspace 1 conversation; while it streams, restart the backend.
2. Watch the UI until the backend is back, then reload the conversation URL.
3. Send a short follow-up.

**Expect (UI)** during the outage the conversation shows an inline connection or stream error with a way to continue (never a blank page); after the restart the transcript shows every message persisted before the cut; the follow-up is answered on the **same** `conv_…`. *Uncertain:* whether the interrupted turn completes after reconnect or ends in a clear error; record which. A rolling deploy may land a tool call on a replica that is not running the turn (known limit, ticket 02).
**Expect (backend)** the interrupted `chat_runs` row ends in a terminal state (not `running` forever); the conversation's sandbox is reattached or recreated from its session branch (`workspace_sandbox_instances`), not duplicated.
**Budget** 90 s / 3 min, restart to a working follow-up.
**Evidence** `RES-1-1.png` (outage state), `RES-1-2.png` (recovered); traces before and after; run states.

### RES-2 Worker sleep and wake (`preview-only`)
**Requires** `preview` mode; Workspace 1 hydrated; a commit pushed to the workspace repository after the wait ([HYD-3](../hydrate/SKILL.md) steps).
**Steps**
1. Leave the preview untouched for 4 minutes (preview workers idle-exit after about 180 s).
2. Check the worker service status (Railway MCP).
3. Push a commit to the workspace repository, then reload the Workspace.

**Expect (UI)** the Workspace never shows a blank or failed state while the worker is asleep; hydrate shows **Hydrate pending** or **Hydrating**, then **Hydrate ready** on the new SHA once the worker wakes (or the harness wake rule is applied).
**Expect (backend)** the worker deploy timestamp moves or the service returns to `RUNNING`; the enqueued `workspace-tip-check` and `workspace-hydrate` runs complete after the wake, none are lost.
**Budget** 90 s / 3 min, push to **Hydrate ready**.
**Evidence** `RES-2-1.png`; worker status before and after; run ids.

### RES-3 Errors render inline, never a blank page
**Requires** ONB-5; accounts A and C.
**Steps**
1. As A, open `/{orgSlug}/ws/does-not-exist-{run-id}` and `/{orgSlug}/ws/{workspace1Slug}/conv_does_not_exist`.
2. As C (not a member), open `/{orgSlug}/`.
3. If the driver can override network responses, make the chat websocket or a Workspace API call fail (500) once while on a conversation.

**Expect (UI)** the app shell stays visible; step 1 shows a Workspace or conversation not-found message with a link back; step 2 shows **You do not have access to this organisation**; step 3 shows an inline error with **Try again** and recovers when the failure is removed. No step shows a white screen or an uncaught error overlay.
**Expect (backend)** the 4xx/5xx responses appear as spans with the right status; nothing is created.
**Budget** 3 s / 10 s per error screen.
**Evidence** `RES-3-1.png` to `RES-3-3.png`; status codes; traces. Step 3 is `SKIP(no-fixture)` when the driver cannot intercept requests.

## Status

- **PASS** RES-3 `PASS`; RES-1 and RES-2 `PASS` or `SKIP`.
- **FAIL** a blank page, an interrupted run stuck `running`, a duplicate sandbox after restart, or lost enqueued jobs after the worker slept.
