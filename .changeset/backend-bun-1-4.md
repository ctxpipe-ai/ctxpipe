---
"@ctxpipe/aws-cdk": patch
---

The backend and worker images run on Bun 1.4.2. Reading streamed model responses costs several times less CPU than on Bun 1.3, so concurrent advisor requests no longer saturate a small backend task. Bun 1.4 checks TLS certificates against the connection host: if `DATABASE_URL` or `GRAPH_DB_URI` reaches a TLS server by IP address or through a `localhost` port-forward, use the hostname on its certificate.
