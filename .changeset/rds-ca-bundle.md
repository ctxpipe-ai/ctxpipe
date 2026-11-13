---
"@ctxpipe/aws-cdk": patch
---

The backend and worker images trust the Amazon RDS CA bundle (`NODE_EXTRA_CA_CERTS`). A database URL that asks for a verified TLS connection (`sslmode=verify-full`) to Aurora now passes the certificate check. The database URLs of the construct do not change.
