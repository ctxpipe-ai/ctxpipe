---
"ctxpipe": patch
---

Local memory capture no longer raises candidates for subagent reports, which Claude Code sends to the main agent as prompts, or for pull request approvals: "approved" on its own no longer marks a decision. Each of these forced an extra agent turn to dismiss.
