---
"@ctxpipe/aws-cdk": patch
---

Knowledge plane: `get_related` now also returns each document on the path from a seed to a result that answers the question. Before, the loop explored such a middle document and found the far document through it, and then dropped the middle document because it did not answer the question alone. A step keeps its own relevance score, so it comes after the results that answer. The disagreement positions still compare only the results that answer.
