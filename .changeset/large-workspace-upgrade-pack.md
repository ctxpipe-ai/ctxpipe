---
"@ctxpipe/aws-cdk": patch
---

A Workspace upgrade and a Workspace write no longer fail with "stdout maxBuffer length exceeded" on a large Workspace repository. ctxpipe now writes the Git pack and the large Git outputs of the format 3 upgrade (the file list, the Markdown files and their history) to temporary files. A Git pack larger than 190 MiB gives a clear error. A Git command that takes too long gives a known timeout error. The upgrade card names these causes and gives a next step, and the worker logs each failed upgrade.
