---
name: preview-env-resilience
description: Backend restart mid-chat, and inline errors instead of blank pages (preview-env).
disable-model-invocation: true
---

# preview-env resilience

Last area: it disturbs the target. [Harness](../harness.md) is `PASS`; run it after the other areas. Flow format: [run-setup](../run-setup.md#flow-format). RES-2 (worker sleep and wake) went with the Railway previews: no target sleeps its worker.

### RES-1 Backend restart mid-chat (`gated-restart-ok`)
**Requires** flag `restart-ok` (a human or the run may restart the backend: `local` only, stop and start `pnpm dev`, per the [write policy](../run-setup.md#write-policy)); CHAT-2.
**Steps**
1. Send a long-answer prompt in the Workspace 1 conversation; while it streams, restart the backend.
2. Watch the UI until the backend is back, then reload the conversation URL.
3. Send a short follow-up.

**Expect (UI)** during the outage the conversation shows an inline connection or stream error with a way to continue (never a blank page); after the restart the transcript shows every message persisted before the cut; the follow-up is answered on the **same** `conv_…`. *Uncertain:* whether the interrupted turn completes after reconnect or ends in a clear error; record which. A rolling deploy may land a tool call on a replica that is not running the turn (known limit, ticket 02).
**Expect (backend)** the interrupted `chat_runs` row ends in a terminal state (not `running` forever); the conversation's sandbox is reattached or recreated from its session branch (`workspace_sandbox_instances`), not duplicated.
**Budget** 90 s / 3 min, restart to a working follow-up.
**Evidence** `RES-1-1.png` (outage state), `RES-1-2.png` (recovered); traces before and after; run states.

### RES-3 Errors render inline, never a blank page
**Requires** ONB-4; accounts A and C.
**Steps**
1. As A, open `/{orgSlug}/ws/does-not-exist-{run-id}` and `/{orgSlug}/ws/{workspace1Slug}/conv_does_not_exist`.
2. As C (not a member), open `/{orgSlug}/`.
3. If the driver can override network responses, make the chat websocket or a Workspace API call fail (500) once while on a conversation.

**Expect (UI)** the app shell stays visible; step 1 shows a Workspace or conversation not-found message with a link back; step 2 shows **You do not have access to this organisation**; step 3 shows an inline error with **Try again** and recovers when the failure is removed. No step shows a white screen or an uncaught error overlay.
**Expect (backend)** the 4xx/5xx responses appear as spans with the right status; nothing is created.
**Budget** 3 s / 10 s per error screen.
**Evidence** `RES-3-1.png` to `RES-3-3.png`; status codes; traces. Step 3 is `SKIP(no-fixture)` when the driver cannot intercept requests.

## Status

- **PASS** RES-3 `PASS`; RES-1 `PASS` or `SKIP`.
- **FAIL** a blank page, an interrupted run stuck `running`, a duplicate sandbox after restart.
