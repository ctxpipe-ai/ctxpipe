---
"@ctxpipe/aws-cdk": patch
---

The service images now use Bun 1.4.4 and Node 24.22.1, and the chat sandbox image uses Node 24.22.1 with the updated Debian `ca-certificates`. The custom-resource Lambda functions now run on Node.js 24 (`nodejs24.x`). These releases no longer trust eight eMudhra intermediate CA certificates that the root programs removed in October 2026. The older images still accept TLS connections through those intermediates.

Upgrade: run `pnpm update @ctxpipe/aws-cdk`, then `cdk deploy`. There are no new props. If you run the Docker Compose stack, run `docker compose build --pull` to build the images on the new base images.
