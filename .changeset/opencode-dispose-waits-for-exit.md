---
"@ctxpipe/aws-cdk": patch
---

The workspace chat now stops its OpenCode server completely before the turn continues. Before, the stop could return while the server still answered for some milliseconds.
