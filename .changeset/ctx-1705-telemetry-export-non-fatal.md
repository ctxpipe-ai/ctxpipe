---
"@ctxpipe/aws-cdk": patch
---

fix: The backend no longer stops when its OTLP collector is down during shutdown. A failed telemetry export now writes one `otlp.export-failed` log line per minute, not one line with a stack for each batch. On ECS, backend and worker telemetry carry the task id as `service.instance.id`, and both report the gauge `process.memory.usage` (resident memory in bytes). When the worker process exits, the `openworkflow.worker-exited` line names the workflow runs that it held.
