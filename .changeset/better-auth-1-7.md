---
"@ctxpipe/aws-cdk": patch
---

Update Better Auth from 1.6.23 to 1.7.27, which includes the fix for advisory GHSA-965c-763c-88jm (CVE-2026-114607). ctxpipe does not enable the Magic Link plugin, so the attack in that advisory did not apply. A new migration adds the tables and nullable columns that the Better Auth 1.7 OAuth provider needs. Better Auth 1.7 does not start before this migration runs. After the update, a sign-in or an MCP OAuth authorization that started before the update cannot complete. Start it again.
