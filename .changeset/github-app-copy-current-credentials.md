---
"@ctxpipe/aws-cdk": patch
---

GitHub: a connection that stores a copy of the deployment App's credentials uses the current `GITHUB_PRIVATE_KEY` and `GITHUB_WEBHOOK_SECRET`. Before, it used the old copy, so after a key rotation GitHub refused each request for the connection ("A JSON web token could not be decoded"), and the old webhook secret still worked on the connection's webhook URL. A connection with its own App keeps its own credentials.
