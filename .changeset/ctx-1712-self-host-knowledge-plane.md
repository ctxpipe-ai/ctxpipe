---
"@ctxpipe/aws-cdk": minor
---

The new knowledge store (ClickHouse) is on for each organization of a self-hosted install. You do not do a step to turn it on. After the deploy, the worker indexes each Workspace in ClickHouse. When the index of a Workspace is complete, chat and MCP read that Workspace from the new knowledge store. Until then, the old knowledge store answers. On our hosted service, the first index of a Workspace took about 3 minutes at the median, and up to about 30 minutes for a large Workspace.

The new knowledge store needs model settings that reach OpenRouter (`modelProvider.kind: "openai-like"` with the OpenRouter URL and key). Its decision model, embedding model and image model are only on OpenRouter. With `modelProvider.kind: "bedrock"`, the worker logs `knowledge_plane.model_settings` at start, and the old knowledge store continues to answer.

Docker Compose: the new one-shot service `clickhouse-secrets` generates the three ClickHouse passwords at the first deploy. You do not have to set them. A password that you set in `.env` replaces the generated one.

Upgrade: there are no new required props. Run `pnpm update @ctxpipe/aws-cdk`, then `cdk deploy`. See "The switch to the new knowledge store" on the Upgrades page.
