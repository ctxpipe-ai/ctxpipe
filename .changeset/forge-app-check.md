---
"@ctxpipe/aws-cdk": patch
---

The Confluence Forge webhook accepts a call only from the Forge app of the connection, with the Forge issuer. Forge provisioning saves the app ID before it installs the app. The installation and the site come from the signed Forge claims.
