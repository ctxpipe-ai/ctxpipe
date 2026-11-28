---
"@ctxpipe/aws-cdk": patch
---

fix: A knowledge projection run whose step stopped the worker three times (for example, out of memory) now fails with the crash-loop error, and no worker claims the run again. The error event `openworkflow.step-crash-loop` names the workflow. The next hydrate or push of the Workspace starts a new projection run.
