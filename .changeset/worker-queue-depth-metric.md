---
"@ctxpipe/aws-cdk": patch
---

The OpenWorkflow worker reports its queue depth as the OpenTelemetry gauges `openworkflow.queue.depth` and `openworkflow.runs.active`. On ECS, it also writes the depth as the CloudWatch metric `ctxpipe` / `WorkerQueueDepth` (Embedded Metric Format on stdout).
