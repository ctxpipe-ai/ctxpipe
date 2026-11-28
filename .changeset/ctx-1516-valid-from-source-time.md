---
"@ctxpipe/aws-cdk": patch
---

fix: Knowledge: a document is valid from the time of its source (the creation time of a mirrored issue, pull request or Slack thread, or the date of a design record), not from the ingest date. Thus a time question with `validAt` finds the knowledge of that time. A file with no time of its own keeps the time of the commit that introduced it (CTX-1516).
