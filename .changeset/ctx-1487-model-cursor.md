---
"@ctxpipe/aws-cdk": patch
---

The `decisions`, `apis`, and `dependencies` skills of ingestion have no page count: each page moves a cursor over the candidates of the skill's own finder. They also have no count caps that dropped input: each decision file, specification operation, route, and dependency candidate is read, and a list for the model ends at a size limit and gives the rest on the next run. `classify-kind` and `instruction-areas` have one page; when that page says that files wait, the skill stops as partial and keeps its files. The new skill bundle version offers a re-ingestion (CTX-1487).
