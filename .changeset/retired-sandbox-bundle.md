---
---

When the push refuses commits because of what they change, the Vercel sandbox retirement saves them as a Git bundle in S3 (`RETIRED_SANDBOX_STORE`). Then it deletes the sandbox. Until the bundle is saved, the sandbox stays.
