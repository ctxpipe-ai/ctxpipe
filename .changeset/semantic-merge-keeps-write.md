---
"@ctxpipe/aws-cdk": patch
---

A Workspace write no longer fails when the merge model reaches its time limit. The merge asks the model about one conflicting file at a time and asks again a few times. If the model still gives no usable answer, the write keeps both versions of that file in Git conflict markers. Remove the markers in the Workspace repository to finish the merge.
