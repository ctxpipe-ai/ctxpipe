---
"@ctxpipe/aws-cdk": patch
---

A Workspace upgrade and a Workspace write no longer fail with "stdout maxBuffer length exceeded" when the Git pack of the Workspace repository is larger than 64 MiB. ctx| now writes the pack to a temporary file. A pack larger than 256 MiB gives a clear error. The upgrade card names this cause and gives a next step, and the worker logs each failed upgrade.
