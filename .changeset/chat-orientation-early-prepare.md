---
"@ctxpipe/aws-cdk": patch
---

Workspace chat answers with fewer exploring steps. The agent gets a short summary of the Workspace: the searchable repositories and the largest knowledge folders with their file counts. The summary never lists file names and stays under 2,000 characters. A new conversation starts its sandbox when the composer gets focus, so the first turn waits less. Traces show the reasoning effort of each model call.
