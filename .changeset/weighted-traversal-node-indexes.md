---
"@ctxpipe/aws-cdk": patch
---

Give the advisor better facts from the graph.

- The graph walk ranks edges by relation type and evidence. A large service no longer hides its dependencies, owners and decisions. The walk skips facts that have ended.
- At equal rank, the walk keeps nodes that the search found, then the newest pull requests.
- A "why" question now reaches the pull requests that added an ADR or changed a lesson. Their descriptions hold the work summary.
- The advisor sees each walked node by name, and each fact with its evidence and the file to cite.
- ADRs link to the services they govern and are ranked by status. The extractor reads supersession that is written as a link.
- Node id indexes stop graph writes from scanning every node. Retraction and node deletion scan the graph once per batch.
- A deterministic-only re-index rolls out extractor changes without the LLM extractors.
