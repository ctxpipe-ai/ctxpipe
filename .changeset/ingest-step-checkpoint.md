---
"@ctxpipe/aws-cdk": patch
---

improvement: Ingest: a model step that runs close to the 10-minute step limit now stops its model one minute before the limit and keeps the files that it staged as a page. The next page continues from them. Before, the limit ended the step, the step lost its work, and the retry started again from the start.
