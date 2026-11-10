---
"@ctxpipe/aws-cdk": patch
---

The OpenWorkflow worker reports its queue depth as the OpenTelemetry gauge `openworkflow.queue.depth`. A hosted deployment (`DEPLOYMENT_ENVIRONMENT` set) also writes the depth as the CloudWatch metric `ctxpipe` / `WorkerQueueDepth` (Embedded Metric Format on stdout).
