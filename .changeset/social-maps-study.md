---
"@ctxpipe/aws-cdk": patch
---

Reduce instruction-unit extraction latency on dense agent-rule files by preferring one unit per normative span, capping `source_excerpt` length, disabling reasoning on that call, and deduping identical excerpts before promotion.
