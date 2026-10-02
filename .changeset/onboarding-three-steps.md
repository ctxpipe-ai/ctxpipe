---
"@ctxpipe/aws-cdk": patch
---

Onboarding is three steps (organisation, GitHub, agent) beside a live diagram. The agent step completes when the backend records the user's agent's first MCP call; the `users` table gains `first_mcp_call_at`, `first_mcp_client` and `first_mcp_tool`. Team invites move to an "Invite your team" row on the org home, and MCP config pull requests stay on the Repositories page.
