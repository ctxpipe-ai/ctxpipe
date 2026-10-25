---
"@ctxpipe/aws-cdk": patch
---

A Workspace write no longer fails when the merge model reaches its time limit. The merge asks the model about one conflicting file at a time and asks again a few times. If the model still gives no usable answer for a Markdown file, the write keeps both versions of that file in Git conflict markers. Hydrate skips that file and shows it as a skipped file with a "Fix using agent" action. Remove the markers to finish the merge. For a file that is not Markdown, or a file that one side deleted, the write fails with its cause.
