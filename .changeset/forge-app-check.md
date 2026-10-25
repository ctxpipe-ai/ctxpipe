---
"@ctxpipe/aws-cdk": patch
---

The Confluence Forge webhook accepts a call only from the Forge app of the connection, with the Forge issuer, and only for one minute after Forge signs it. Forge provisioning saves the app ID before it installs the app. A deployment accepts only the Forge `production` environment; a Railway PR preview and local development also accept `development` and `staging`. The installation and the site come from the signed Forge claims.
