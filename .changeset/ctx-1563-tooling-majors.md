---
"ctxpipe": minor
"@ctxpipe/aws-cdk": patch
---

The `ctxpipe` CLI now needs Node.js 22.12 or newer (`engines`), because chalk 6 and commander 15 dropped older versions. The backend takes uuid 14, which changes no behavior that operators see.
