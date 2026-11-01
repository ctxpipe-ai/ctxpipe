---
"@ctxpipe/aws-cdk": patch
---

A connector mirror write no longer goes to the semantic merge. Each attempt compares the write with the tip. When a file on the tip is a strictly newer snapshot of its item, the full write changes nothing. Otherwise the write lands, also when the update times are equal. When the tip moves during each of 5 attempts, the write job fails and the next sync of the item writes it again. A file with conflict markers on the tip gets the next snapshot of its item.
