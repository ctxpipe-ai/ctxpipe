---
"@ctxpipe/aws-cdk": patch
---

The backend and worker images trust the Amazon RDS CA bundle (`NODE_EXTRA_CA_CERTS`), so that each database driver can verify an Aurora certificate.
