---
"@ctxpipe/aws-cdk": patch
---

The service images now use Bun 1.4.4 and Node 22.23.4, and the chat sandbox image uses Node 22.23.4 with the updated Debian `ca-certificates`. These releases no longer trust eight eMudhra intermediate CA certificates that the root programs removed in October 2026. The older images still accept TLS connections through those intermediates.

Upgrade: run `pnpm update @ctxpipe/aws-cdk`, then `cdk deploy`. There are no new props. If you run the Docker Compose stack, pull or build the new images.
