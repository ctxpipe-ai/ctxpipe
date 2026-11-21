---
---

Sandbox Git sends the proxy session in its first CONNECT, so parallel ingest fetches do not get a proxy 429. A prepare clone runs again after a short proxy 429 burst (CTX-1470).
