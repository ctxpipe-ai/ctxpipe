---
"@ctxpipe/aws-cdk": patch
---

The service images and the chat sandbox image now use Node 26.13.1, the current Node LTS release.

Upgrade: run `pnpm update @ctxpipe/aws-cdk`, then `cdk deploy`. There are no new props. If you run the Docker Compose stack, run `docker compose build --pull` to build the images on the new base images.
