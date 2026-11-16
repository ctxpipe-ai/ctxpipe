---
"@ctxpipe/aws-cdk": patch
---

The UI server render now calls the backend on its Cloud Map address (`http://backend.ctxpipe.local:3000`), not through the load balancer. Better Auth then sees the address of each browser, and the auth rate limit counts each browser. The UI gets `AUTH_ALLOWED_ORIGINS` set to the public app URL, and the app security group allows the backend port 3000.
