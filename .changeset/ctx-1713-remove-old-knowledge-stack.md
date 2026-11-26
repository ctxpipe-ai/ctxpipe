---
"@ctxpipe/aws-cdk": major
---

Remove the old knowledge read stack. The knowledge plane now serves every organization, and ClickHouse holds all knowledge content.

These parts are removed:

- The Neptune cluster, its instance, its subnet group, its security group and rules, and its backups. The size profiles have no Neptune instance class.
- The `GRAPH_DB_PROVIDER`, `GRAPH_DB_URI`, and `GRAPH_DB_URI_<orgSlug>` settings of the backend and worker tasks. The backend does not read `GRAPH_DB_URI`, `GRAPH_DB_USER`, `GRAPH_DB_PASSWORD`, `GRAPH_DB_PROVIDER`, or `GRAPH_DB_URI_<orgSlug>` any more.
- The Postgres knowledge chunk tables. A migration drops them (the contract step of ADR-053).
- The FalkorDB service in Docker Compose.

There is no fallback to the old stack. After the deploy, the migrate step queues the knowledge projection of each Workspace. Until the projection of a Workspace ends, its knowledge tools give `workspace_not_ready`, and the graph view shows that the graph is building.

When you update a stack to this version, CloudFormation deletes the Neptune cluster and its instance. The cluster has a snapshot removal policy, so AWS keeps a final snapshot. Neptune held only derived data, and ClickHouse holds the knowledge, so no data is lost. Delete the final snapshot when you do not need it.

The `orgSlug` prop is removed: only Neptune used it. Remove `orgSlug` from your `CtxPipe` props when you upgrade.
