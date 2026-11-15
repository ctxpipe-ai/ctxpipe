---
"@ctxpipe/aws-cdk": patch
---

The auth rate limit and the session use the client address that the nearest proxy appended to X-Forwarded-For. Behind Cloudflare and behind the preview router, a client can no longer choose its address with its own X-Forwarded-For or X-Real-IP header. The server render of the UI forwards the client address headers. When the UI calls the backend on its private address, as on the hosted stack, the backend rate limits each browser and not the UI server. A job that a request queues and that fails after the response writes its error as an event of its own, with the request id. evlog writes no "log.error() called after the wide event" warning.
