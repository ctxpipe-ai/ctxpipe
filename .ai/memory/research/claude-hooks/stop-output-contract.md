# Claude Code Stop hook JSON output contract

Date: 2026-08-31  
CLI tested locally: **2.1.251** (`claude --version`)  
Scope: `Stop` and `SubagentStop` stdout JSON for command/HTTP hooks (not prompt/agent hooks).

## Executive summary

Official docs (post **v2.1.163**) describe **two** continuation channels on `Stop`/`SubagentStop`: top-level `decision: "block"` + `reason` (loud; transcript label **“Stop hook error:”**) and `hookSpecificOutput.additionalContext` with `hookEventName: "Stop"` or `"SubagentStop"` (neutral; **“Stop hook feedback:”**). A **validation failure** on any JSON shape is **non-blocking**: the turn **ends**, the user sees **`Stop hook error: Hook JSON output validation failed — …`**, and Claude **does not** receive the hook’s follow-up.

We reproduced the **ctxpipe** failure mode: shipped `finalize` emitted `hookSpecificOutput.additionalContext` on `Stop` and hit exactly that validation error on **2.1.251**. Anthropic’s own **hookify** plugin and collaborator guidance use **`decision: "block"` + `reason`** instead. Docs, release notes, and a collaborator comment claim `additionalContext` works from **v2.1.163** onward; community reports before that version and our **2.1.251** observation contradict the “fixed everywhere” story — treat **`decision: "block"` + `reason`** as the portable contract until independently re-verified on the installed CLI.

---

## Primary sources

| Source | URL / ref |
|--------|-----------|
| Hooks reference | https://code.claude.com/docs/en/hooks |
| Hooks guide | https://code.claude.com/docs/en/hooks-guide |
| Release v2.1.163 | https://github.com/anthropics/claude-code/releases/tag/v2.1.163 |
| Release v2.1.251 | https://github.com/anthropics/claude-code/releases/tag/v2.1.251 |
| #50682 — additionalContext rejected (2.1.114) | https://github.com/anthropics/claude-code/issues/50682 |
| #24244 — `continueWith` feature request | https://github.com/anthropics/claude-code/issues/24244 |
| #60993 — soft Stop reminders (dup of #50682) | https://github.com/anthropics/claude-code/issues/60993 |
| #65495 — docs lag for v2.1.163 Stop additionalContext | https://github.com/anthropics/claude-code/issues/65495 |
| #12667 — `decision: block` shown as “error” | https://github.com/anthropics/claude-code/issues/12667 |
| #84385 — same UX + collaborator response | https://github.com/anthropics/claude-code/issues/84385 |
| hookify plugin Stop output | `anthropics/claude-code` → `plugins/hookify/core/rule_engine.py` |

---

## Docs vs validator (timeline)

### Before v2.1.163

[#50682](https://github.com/anthropics/claude-code/issues/50682) (reporter: **CC 2.1.114**, 2026-04-19) documents that Stop output with:

```json
{
  "hookSpecificOutput": {
    "hookEventName": "Stop",
    "additionalContext": "…"
  }
}
```

or combined with `decision: "block"` produces:

```text
Stop hook error: Hook JSON output validation failed — (root): Invalid input
```

The reporter’s schema dump listed `hookSpecificOutput.hookEventName` variants for **PreToolUse, UserPromptSubmit, PostToolUse, PostToolBatch** only — **not Stop**.

### v2.1.163 (2026-05-08 release notes)

> Hooks: Stop and SubagentStop hooks can now return `hookSpecificOutput.additionalContext` to give Claude feedback and keep the turn going **without being labeled a hook error**

([v2.1.163 release body](https://github.com/anthropics/claude-code/releases/tag/v2.1.163))

[#65495](https://github.com/anthropics/claude-code/issues/65495) filed because the live hooks page still said SubagentStop did not support `additionalContext`. Docs were updated; verification comment (2026-06-27) marks the page resolved.

### Current docs (scraped 2026-08-31)

**Decision control summary table** ([hooks reference](https://code.claude.com/docs/en/hooks#decision-control)):

> UserPromptSubmit, UserPromptExpansion, PostToolUse, PostToolUseFailure, PostToolBatch, **Stop, SubagentStop**, ConfigChange, PreCompact | Top-level `decision` | `decision: "block"`, `reason`. **Stop and SubagentStop also accept `hookSpecificOutput.additionalContext`** for non-error feedback that continues the conversation

**Stop decision control** ([hooks reference — Stop decision control](https://code.claude.com/docs/en/hooks#stop-decision-control)):

| Field | Docs claim |
|-------|------------|
| `decision` | Only `"block"`. Omit to allow stop. |
| `reason` | Required when `decision` is `"block"`. Fed to Claude as why to continue. |
| `hookSpecificOutput.additionalContext` | Non-error feedback; turn continues; transcript **“Stop hook feedback”**, not a hook error. |

Docs quote on `additionalContext`:

> Use `additionalContext` when the hook is working as designed and giving Claude guidance … It keeps the conversation going through the same loop protections as `decision: "block"`, namely the **`stop_hook_active` input and the 8-consecutive-continuation cap**, but the transcript labels it **`Stop hook feedback`** and no hook error notification is shown

**Add context for Claude** lists Stop/SubagentStop alongside other events that accept nested `additionalContext`.

**SubagentStop** ([hooks reference — SubagentStop](https://code.claude.com/docs/en/hooks#subagentstop)):

> SubagentStop hooks use the same decision control format as Stop hooks, including `hookSpecificOutput.additionalContext` with `hookEventName` set to `"SubagentStop"`

### Collaborator test (2.1.233)

On [#84385](https://github.com/anthropics/claude-code/issues/84385), **@bcherny** (collaborator, 2026-08) states that on **2.1.233**:

- `{"decision": "block", "reason": "…"}` → **`Stop hook error:`** label, Claude continues (intended).
- `{"hookSpecificOutput": {"hookEventName": "Stop", "additionalContext": "…"}}` → **`Stop hook feedback:`**, Claude continues, same `stop_hook_active` / 8-cap behaviour.

### Observed in a long-lived Claude session (this repo)

`ctxpipe memory capture finalize --host claude --event Stop` (prior shipped shape) printed:

```json
{"hookSpecificOutput":{"hookEventName":"Stop","additionalContext":"…"}}
```

The running session reported:

```text
Stop hook error: Hook JSON output validation failed — (root): Invalid input
```

The **error-dump schema** in that session listed `hookSpecificOutput` variants for PreToolUse / UserPromptSubmit / PostToolUse / PostToolBatch only, plus a **top-level `permissionDecision`**, and **no `terminalSequence`**. That dump does **not** match the `jxt()` help string in the **2.1.251 binary** on this machine.

### 2.1.251 binary (strings, 2026-08-31)

Inspected `/Users/thomaspeterson/.local/share/claude/versions/2.1.251` (`claude --version` → `2.1.251`; symlink mtime that evening). The bundled Zod unions **do** include:

```text
hookEventName: "Stop", additionalContext?: string
hookEventName: "SubagentStop", additionalContext?: string
```

The in-binary expected-schema dump (`jxt()`) also includes `"for Stop / SubagentStop"` and `terminalSequence`. So **current 2.1.251 accepts `additionalContext` on Stop**. The session that rejected it was almost certainly an **older in-memory CLI** (started before the 2.1.251 upgrade). Anthropic source for the Zod module is still not public.

**Implication:** `additionalContext` is the nicer UX on a fresh 2.1.163+ process, but a **stale session or older install rejects the whole object and ends the turn**. `decision: "block"` + `reason` validates on both the old dump and 2.1.251. Do not emit `hookSpecificOutput` on Stop until we can require a minimum Claude Code version.

---

## Explicit Q&A

### What JSON shapes continue a Stop without validation error on 2.1.x?

| Shape | Validates (docs) | Continues turn (docs) | Observed / reported |
|-------|------------------|----------------------|---------------------|
| `{}` or exit 0, empty stdout | Yes | No — allows stop | — |
| `{"decision":"block","reason":"…"}` | Yes (since pre-2.1.163) | Yes | Yes — hookify, bcherny #84385, local ctxpipe after fix |
| `{"hookSpecificOutput":{"hookEventName":"Stop","additionalContext":"…"}}` | Yes since **v2.1.163** (docs + release) | Yes | **Rejected** on 2.1.114 (#50682) and a **stale long-lived session** in this repo; **accepted** in the **2.1.251 binary** Zod union and per bcherny on **2.1.233** |
| Exit **2** + stderr (no/any JSON) | N/A | Yes — blocks stop | Yes — same continuation path as `reason` ([Stop decision control](https://code.claude.com/docs/en/hooks#stop-decision-control)) |
| `{"continue":false,"stopReason":"…"}` | Yes (universal) | **No** — stops Claude entirely | Universal field; different semantics |
| `{"decision":"approve"}` | **No** — invalid enum | — | Docs: only `"block"` exists ([Top-level decision](https://code.claude.com/docs/en/hooks#top-level-decision)) |

**Practical recommendation for ctxpipe:** emit **`{"decision":"block","reason":"<summary>"}`** on Claude/Codex Stop; suppress when `stop_hook_active === true` ([hooks guide — Stop hook hits the block cap](https://code.claude.com/docs/en/hooks-guide#stop-hook-hits-the-block-cap)).

### Does `decision: "block" + reason` show as a user-visible hook error?

**Yes.** Transcript pattern ([#12667](https://github.com/anthropics/claude-code/issues/12667), [#84385](https://github.com/anthropics/claude-code/issues/84385), reproduced by @bcherny on 2.1.233):

```text
Ran N stop hook(s)
  ⎿  Stop hook error: <reason>
```

Anthropic treats this as **intentional** for `decision: "block"` (“hook overrode Claude’s decision to stop”). Docs steer authors who want neutral copy toward **`additionalContext`** → **“Stop hook feedback:”**.

Exit **2** on Stop also prevents stopping; stderr is routed like `reason` ([Exit code 2 behaviour — Stop](https://code.claude.com/docs/en/hooks#exit-code-2-behavior-per-event)).

### Does `systemMessage` continue the turn or only notify the user?

**Notify only** (unless paired with a continuation field). Universal table ([JSON output](https://code.claude.com/docs/en/hooks#json-output)):

> `systemMessage` — Warning message **shown to the user**

Stop decision control documents **`decision`**, **`reason`**, and **`additionalContext`** only — not `systemMessage` as a continuation mechanism. Anthropic **hookify** returns all three on Stop:

```python
{"decision": "block", "reason": combined_message, "systemMessage": combined_message}
```

(`plugins/hookify/core/rule_engine.py`) — implying `systemMessage` is supplementary UI while **`decision: "block"`** drives continuation.

### Is `decision: "approve"` valid?

**No.** Hooks reference ([Top-level decision](https://code.claude.com/docs/en/hooks#top-level-decision)):

> The only value for `decision` is `"block"`. To allow the action to proceed, omit `decision` from your JSON, or exit 0 without any JSON at all.

(`"approve"` / `"block"` deprecation applies to **PreToolUse** → `permissionDecision` allow/deny, not Stop.)

### Does `decision: "block"` **with** `hookSpecificOutput.additionalContext` fail validation (whole object rejected)?

- **Pre-2.1.163:** [#50682](https://github.com/anthropics/claude-code/issues/50682) — combined shape → validation failed (whole object rejected; turn ended).
- **Post-2.1.163 docs:** [#65495](https://github.com/anthropics/claude-code/issues/65495) suggested example combines both fields intentionally.
- **2.1.251:** Not tested in isolation. If standalone `additionalContext` fails validation (as ctxpipe saw), the combined object likely fails too — **unknown**, not re-run here.

### Version gate / env detection?

| Signal | Use |
|--------|-----|
| `claude --version` | Authoritative CLI semver (e.g. `2.1.251`) |
| **v2.1.163+** | Release note: Stop/SubagentStop `additionalContext` |
| **v2.1.251+** | SessionStart resume hooks gain extra input fields ([hooks reference — SessionStart](https://code.claude.com/docs/en/hooks#sessionstart)) |
| `stop_hook_active` (hook **input**) | `true` when already in a Stop continuation loop — exit 0 / `{}` to allow stop |
| `CLAUDE_CODE_STOP_HOOK_BLOCK_CAP` | Raise default **8** consecutive Stop blocks ([hooks guide](https://code.claude.com/docs/en/hooks-guide#stop-hook-hits-the-block-cap)) |
| `CLAUDE_CODE_VERSION` | **Not documented** in hooks reference for output gating — **unknown** |

No documented env var toggles Stop output schema validation.

### SubagentStop — same contract?

**Yes** per docs: same decision fields; `hookEventName` must be **`"SubagentStop"`**. `decision: "block"` + `reason` goes to the **subagent**; parent-session injection → `PostToolUse` on `Agent` tool instead.

### Invalid JSON on Stop — blocking?

**Non-blocking for the session; blocking for continuation intent.**

From [Exit code 0 — schema validation failure](https://code.claude.com/docs/en/hooks#exit-code-0):

> exit 0 with a parsed object that **fails schema validation** is a **non-blocking error**: the action proceeds, and the transcript shows a `Stop hook error` notice with the validation message.

For **Stop**, “action proceeds” = **Claude stops** (turn ends). The follow-up text is **not** injected. Same for JSON **parse** failures ([Exit code output](https://code.claude.com/docs/en/hooks#exit-code-output)).

Contrast: exit **2** on Stop **blocks stopping** even if JSON is invalid (stderr used as reason; validation logged to debug) — behaviour changed at v2.1.214 for some events; Stop exit-2 still prevents stopping per [Exit code 2 — Stop](https://code.claude.com/docs/en/hooks#exit-code-2-behavior-per-event).

### 8-block cap and `stop_hook_active`?

**Must honour.**

- Input: `stop_hook_active: true` when Claude Code is already continuing because of a Stop hook ([Stop input](https://code.claude.com/docs/en/hooks#stop-input)).
- After **8 consecutive** Stop blocks “without progress”, Claude Code **overrides** the hook and ends the turn ([hooks guide](https://code.claude.com/docs/en/hooks-guide#stop-hook-hits-the-block-cap)):

```bash
if [ "$(echo "$INPUT" | jq -r '.stop_hook_active')" = "true" ]; then
  exit 0  # Allow Claude to stop
fi
```

- Override cap: `CLAUDE_CODE_STOP_HOOK_BLOCK_CAP` (same guide section).
- Applies to **`additionalContext`** continuations as well ([Stop decision control](https://code.claude.com/docs/en/hooks#stop-decision-control)).

---

## Exit code vs JSON (Stop)

| Mechanism | Stop effect |
|-----------|-------------|
| Exit **0**, no JSON | Allow stop |
| Exit **0**, valid `decision: "block"` JSON | Continue; **Stop hook error:** + reason |
| Exit **0**, valid `additionalContext` JSON (if validator accepts) | Continue; **Stop hook feedback:** |
| Exit **0**, invalid JSON / failed validation | **Allow stop** + validation notice; **no** continuation |
| Exit **2**, stderr | Continue; stderr → Claude like `reason` |
| Exit **2** + invalid JSON | Still **blocks stop**; stderr is reason |

Docs: do not mix exit **2** with JSON expecting JSON to override the block ([Structured JSON output — hooks guide](https://code.claude.com/docs/en/hooks-guide#structured-json-output)).

---

## Implications for `ctxpipe memory capture finalize`

| Topic | Guidance |
|-------|----------|
| **Emitter** | `--host claude --event Stop` → **`decision: "block"` + `reason`** (not `hookSpecificOutput.additionalContext` until re-verified on target CLI) |
| **Suppress** | Return `{}` when `stop_hook_active === true`, priority low, or empty message |
| **Stdout** | Exactly **one** JSON object per hook run ([run-capture.ts](packages/cli/src/memory/run-capture.ts)) — multi-line JSON objects cause parse failure |
| **UX** | Expect **Stop hook error:** banner even on success path; users may think capture is broken ([#12667](https://github.com/anthropics/claude-code/issues/12667)) |
| **Fallback** | `UserPromptSubmit` + `additionalContext` works but is **one turn late** ([#60993](https://github.com/anthropics/claude-code/issues/60993)) |

---

## Open questions

1. **Why did `additionalContext` fail validation on 2.1.251** when release notes and @bcherny (2.1.233) say it should pass? Regression vs install vs stdout pollution — **not resolved** in this note.
2. **Exact Zod/schema source** for Stop `hookSpecificOutput.hookEventName` enum — not in public repo; only inferred from error dumps and issues.
3. **`systemMessage`-only Stop output** — does it continue or only warn? Not covered in Stop decision control; hookify pairs it with `decision: "block"`.
