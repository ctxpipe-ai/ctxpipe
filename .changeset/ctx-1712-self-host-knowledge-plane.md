---
"@ctxpipe/aws-cdk": minor
---

feature: The new knowledge store (ClickHouse) is on for each organization. You do not do a step to turn it on: the `knowledge_plane` organization setting is removed. After the deploy, the worker indexes each Workspace in ClickHouse. When the index of a Workspace is complete, chat and MCP read that Workspace from the new knowledge store. Until then, the old knowledge store answers. On our hosted service, the first index of a Workspace took about 3 minutes at the median, and up to about 30 minutes for a large Workspace. The chat composer of each organization now shows the base branch picker.

The index runs and the searches send Workspace text, images and questions to three models on OpenRouter: the embedding model `openai/text-embedding-3-large`, the image model, and the decision model (Jev), each with zero data retention.

The new knowledge store needs model settings that reach OpenRouter (`modelProvider.kind: "openai-like"` with the OpenRouter URL and key). Its decision model, embedding model and image model are only on OpenRouter. With `modelProvider.kind: "bedrock"`, the worker indexes no Workspace in the new knowledge store and logs `knowledge_plane.model_settings` at start, and the old knowledge store continues to answer.

Docker Compose: the new one-shot service `clickhouse-secrets` generates the three ClickHouse passwords at the first deploy. You do not have to set them. A password that you set in `.env` replaces the generated one.

Upgrade: there are no new required props. Run `pnpm update @ctxpipe/aws-cdk`, then `cdk deploy`. See "The switch to the new knowledge store" on the Upgrades page.
