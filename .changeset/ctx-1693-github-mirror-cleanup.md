---
"@ctxpipe/aws-cdk": patch
---

feature: GitHub mirrors: an operator script cleans up the pull request and issue mirrors of one Workspace one time. It deletes the mixed-case copies of a path, moves a mixed-case file to its lowercase path, and deletes the mirrors of repositories that no source holds. The script is a dry run with counts only. With `--apply`, it queues one host commit through the write broker.
