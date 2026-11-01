---
"@ctxpipe/aws-cdk": patch
---

Ingestion v2: a publish that withholds merged files now logs the validator rule and reason of those files: one `ingestion-v2.publish-withheld` event for each rule and reason, with the count of files and no path. A `front_matter` withhold then names the field that fails.
