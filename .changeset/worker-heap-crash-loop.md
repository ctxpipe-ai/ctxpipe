---
"@ctxpipe/aws-cdk": patch
---

The OpenWorkflow worker no longer restarts again and again on one ingestion step. The worker keeps only a bounded part of each sandbox command output and refuses a step output over 4 MiB before it reads it. A skill step that stops the worker three times in 2 hours now ends `partial` with its cause, and the run goes on with the next step. The worker supervisor sends SIGTERM and SIGINT on to the worker, so the worker stops cleanly on a deploy. The worker image runs its supervisor and the worker under Node, not Bun. On SIGTERM, the worker marks the step attempts that it runs as failed, so a deploy does not count as a crash. The worker container now gets 30 seconds from SIGTERM to SIGKILL (ECS `stopTimeout`, Compose `stop_grace_period`), and the supervisor kills the worker after 25 seconds.
