---
"@ctxpipe/aws-cdk": patch
---

A connector mirror write no longer goes to the semantic merge. Each attempt compares each file of the write with the tip. A file is dropped when the file on the tip is a strictly newer snapshot of its item. The other files of the write land, also when their update times are equal. The index and the table of a Notion database are dropped too when a row of that database is stale. The write keeps its deletes. When the tip moves during each of 5 attempts, the write job fails and the next sync of the item writes it again. A file with conflict markers on the tip gets the next snapshot of its item.
