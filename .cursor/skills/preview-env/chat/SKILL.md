---
name: preview-env-chat
description: Workspace chat in per-conversation sandboxes: turns, streaming, reload, stop, isolation, idle resume, lost-sandbox rebuild (preview-env).
disable-model-invocation: true
---

# preview-env chat

Stock TanStack `useChat` over a websocket, `chat()` + `withSandbox` + `opencodeText`, models only through the app proxy. One sandbox per conversation. Needs hydrate `ready` ([HYD-1](../hydrate/SKILL.md)), a warm worker, and the model proxy. [Harness](../harness.md) is `PASS`. Flow format: [run-setup](../run-setup.md#flow-format).

**Sandbox provider by mode.** Hosted (`preview`): Vercel Sandbox, one microVM per conversation. Files are saved when idle (a sandbox stops after 5 minutes idle; the next message resumes it), saved state is kept 30 days, at most 50 sandboxes run per org (the next one gets an "at capacity" error), and the GitHub token never enters the sandbox (it lives in the firewall rule). Self-host and `local`: Docker. Flows marked `hosted-only` are `SKIP(hosted-only)` on `local`; flows marked `needs-ticket-02` are `SKIP(needs-ticket-02)` until the Vercel lifecycle lands.

Use a **real** question about the Workspace's repository (a named file, how a feature works). Do not paste a canned "what's in this repo?" prompt. Record the answer time against the 5 s target in [workspace-chat-latency](../../../../.ai/memory/PRDs/workspace-chat-latency.md).

### CHAT-1 First message creates a conversation
**Requires** HYD-1; Workspace 1 composer open.
**Steps**
1. Send a question about a named knowledge file from the template, for example: "Per support-escalation.md, who must approve a manual adjustment of 600 points, and how fast does on-call acknowledge a page?" (answer: a second approver; within 30 minutes).
2. Watch **Setting up sandbox**, then **Thinking…**, then the streamed answer.

**Expect (UI)** the URL becomes `/{orgSlug}/ws/{workspace1Slug}/conv_…`; the user bubble holds the question; **Setting up sandbox** and **Thinking…** clear; assistant text arrives progressively (more than one text update, not one dump) with tool or reasoning chips; the answer cites the named file; the sidebar entry changes from **New conversation** to a model-written title.
**Expect (backend)** `conversations` row (name updated once after the first turn); `chat_threads`, `chat_runs`, `conversation_messages`; `workspace_sandbox_instances` row for the conversation (hosted: Vercel provider, tagged with the environment, started from the Workspace base snapshot with no clone in this turn); hosted `workspace_sandbox_git_tokens` row (encrypted); the model call arrived through the app proxy at a configured tier (default fast), no other model host.
**Budget** 5 s / 15 s, **Send** to a complete answer (the PRD target). Also record time to first token and time to **Setting up sandbox** clearing.
**Evidence** `CHAT-1-1.png` (mid-stream), `CHAT-1-2.png` (final), `chat.webm`; trace of the conversation request and the `opencode.chatStream` / `tanstack-workspace-chat` steps.

### CHAT-2 Second turn on the same conversation (warm)
**Requires** CHAT-1.
**Steps**
1. Send a follow-up that only makes sense after turn 1 ("that file", "the approach you named").

**Expect (UI)** the path keeps the same `conv_…`; **Thinking…** clears; a second assistant bubble appears and references turn 1.
**Expect (backend)** the same `workspace_sandbox_instances` row is reused (no new sandbox); two assistant turns in `conversation_messages`.
**Budget** 5 s / 15 s, **Send** to a complete answer.
**Evidence** `CHAT-2-1.png`; trace.

### CHAT-3 Reload restores the history
**Requires** CHAT-2.
**Steps**
1. Hard-reload the conversation URL.
2. Click another sidebar conversation or **Home**, then return.

**Expect (UI)** both turns are in the transcript after each remount; **Setting up sandbox** may flash while `POST …/conversations/{id}/prepare` runs; the composer is usable.
**Expect (backend)** transcripts come from Postgres (no new `conversations` row); `prepare` returns 200.
**Budget** 2 s / 5 s, reload to transcript visible.
**Evidence** `CHAT-3-1.png`; trace of the conversation GET and prepare.

### CHAT-4 Stop mid-stream
**Requires** CHAT-2.
**Steps**
1. Send a prompt that produces a long answer (ask for a detailed walkthrough of several files).
2. While text streams, press the stop control.
3. Send a short follow-up.

**Expect (UI)** streaming ends within the budget; the partial assistant text stays; the composer is enabled again; the follow-up gets an answer (the agent is not wedged).
**Expect (backend)** the chat run ends as cancelled; hosted: the agent process is killed (or the sandbox stopped) so the sandbox does not keep working; no orphan run keeps spending.
**Budget** 1 s / 3 s, stop to streaming ended.
**Evidence** `CHAT-4-1.png`; the cancelled run in the trace.

### CHAT-5 Two conversations are isolated
**Requires** CHAT-2.
**Steps**
1. Start conversation Y in Workspace 1 (new composer). Ask the agent to create `knowledge/preview-env/{run-id}-y.md`.
2. Return to conversation X (from CHAT-1) and ask it to list files under `knowledge/preview-env/`.

**Expect (UI)** X's answer does not list Y's file; each transcript has only its own turns; sidebar shows both conversations.
**Expect (backend)** two `workspace_sandbox_instances` rows with different sandbox ids; Y's file exists only in Y's sandbox (and on Y's session branch once the agent commits it).
**Budget** 5 s / 15 s per answer.
**Evidence** `CHAT-5-1.png`, `CHAT-5-2.png`; both conversation ids and sandbox ids.

### CHAT-6 Idle stop and resume with files intact (`hosted-only`, `needs-ticket-02`)
**Requires** CHAT-5 (conversation Y has a file turn); hosted preview.
**Steps**
1. Leave Y untouched for 6 minutes.
2. Check the sandbox state (database row and the Vercel sandbox).
3. Send "what is in the file you created?".

**Expect (UI)** after the wait nothing changes in the UI; the next message shows **Setting up sandbox** briefly, then an answer that quotes the file's content (saved files survived the stop).
**Expect (backend)** after about 5 minutes the sandbox row is stopped and its GitHub token revoked; one running slot is freed; on the message the same persistent sandbox resumes (no fresh clone) and a new short-lived token is minted.
**Budget** 8 s / 20 s, **Send** to a complete answer (resume is about 2 s of that); stop within 7 minutes of the last activity.
**Evidence** `CHAT-6-1.png`; sandbox state before and after; trace; token rows.

### CHAT-7 Lost sandbox is recreated from the session branch (`needs-ticket-02`)
**Requires** CHAT-5, then ask Y's agent to commit and push its file (the agent commits on request; see [FP-4](../files-publish/SKILL.md)) and confirm the commit is on the branch; an operator who can delete the sandbox (human checkpoint; `SKIP(needs-human)` otherwise).
**Steps**
1. Delete Y's sandbox (provider console or the database row plus the sandbox).
2. Send a follow-up asking for the file's content.

**Expect (UI)** a short **Setting up sandbox**, then an answer that has the file (rebuilt from `ctxpipe/chat/{conversationId}/1`).
**Expect (backend)** a new `workspace_sandbox_instances` row; the file content came from git, not the lost disk.
**Budget** 10 s / 30 s, **Send** to a complete answer.
**Evidence** `CHAT-7-1.png`; the new sandbox id.

### CHAT-8 No credential inside the sandbox (`hosted-only`, `needs-ticket-02`)
**Requires** CHAT-1.
**Steps**
1. Ask the agent to run `env`, `git config --list`, `cat ~/.git-credentials` if present, and a request to a host outside the allowlist, and to report anything token-like (without printing secret values beyond the first 4 characters).
2. Read the tool chips' output.

**Expect (UI)** no GitHub token or ctx| write credential appears; the request to a non-allowlisted host fails (DNS error); the agent can still `git fetch` the Workspace repository (read access through the firewall).
**Expect (backend)** the sandbox has the network policy applied (allowlist: our backend, GitHub, what OpenCode needs) and an OpenCode server password.
**Budget** 15 s / 45 s.
**Evidence** `CHAT-8-1.png` of the tool output (redact values).

CHAT-9 (at capacity) is retired: `apps/backend/src/domain/workspaces/sandbox-lifecycle-native.contract.test.ts` covers the 50-sandbox cap. Report it as `SKIP(contract-test)`.

## Status

- **PASS** CHAT-1 to CHAT-5 `PASS`; hosted flows `PASS` or `SKIP`.
- **FAIL** a stream error, the sandbox never leaving "Setting up", an empty assistant answer, turn 2 creating a new conversation id, cross-conversation leakage, or a token inside a sandbox.
- **SKIP** no Workspace, `hydrateStatus !== "ready"`, or chat blocked by an explicit prepare error (record the chip or JSON).

On FAIL attach the traces and logs: `opencode.chatStream` / `tanstack-workspace-chat` ([observability](../../observability/SKILL.md)). A conversation POST **200** only means the stream opened.
