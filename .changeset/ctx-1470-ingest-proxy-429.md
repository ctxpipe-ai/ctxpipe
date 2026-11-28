---
"@ctxpipe/aws-cdk": patch
---

fix: Sandbox Git sends the proxy session in its first CONNECT, so parallel ingest fetches do not get a proxy 429. A prepare clone runs again after a short 429 burst, and it waits for the Retry-After of the proxy (CTX-1470).
