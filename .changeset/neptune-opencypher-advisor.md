---
"@ctxpipe/aws-cdk": patch
---

Fix ctx_advisor on Neptune-backed AWS CDK deploys: graph traversal now uses openCypher `size()` list predicates instead of Neo4j `ALL()`, advisor failures emit on the process logger so they survive a sealed request event, and the tool description no longer uses mandatory override language.
