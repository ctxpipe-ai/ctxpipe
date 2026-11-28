---
"@ctxpipe/aws-cdk": patch
---

fix: The knowledge projection writes the files of a Workspace in groups of at most 2 MiB of file content, not 1,000 files. A group of 1,000 large files (for example mirrored issues) held more than 1 GiB in the worker until its insert, and the worker of a 2 GiB task stopped. A file above 2 MiB is a group alone.
