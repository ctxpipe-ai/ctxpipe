---
"@ctxpipe/aws-cdk": patch
---

The Confluence Forge webhook accepts a call only from the Forge app of the connection, with the Forge issuer. A production deployment accepts only the Forge `production` environment. The installation and the site come from the signed Forge claims.
