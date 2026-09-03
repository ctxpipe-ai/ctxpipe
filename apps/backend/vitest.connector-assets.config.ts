import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    environment: "node",
    include: [
      "src/services/*/{assets,client,converter,incremental,markdown-images,page-tree,sync}.test.ts",
      "src/services/confluence/forge-confluence-webhook.test.ts",
      "src/services/github/installation-write-client.test.ts",
      "src/lib/forge-app-manifest.test.ts",
      "src/models/{notion-connector,repositories}.test.ts",
      "src/routes/v1/connectors-{atlassian,linear,notion,slack}.test.ts",
      "src/routes/webhooks/{atlassian,linear,notion,slack}/*.test.ts",
      "src/routes/webhooks/github/github.test.ts",
      "src/routes/webhooks/github/github-{confluence,linear,notion}-push.test.ts",
      "src/openworkflow/namespace.test.ts",
      "src/openworkflow/enqueue-{follow-up-if-tip-ahead,repository-ingestion}.test.ts",
      "src/openworkflow/workflows/*-workflow-discovery.test.ts",
      "src/openworkflow/workflows/*-sync-{content,entity,space}.test.ts",
      "src/openworkflow/workflows/repository-ingestion*.test.ts",
      "src/openworkflow/workflows/slack-mention-agent.test.ts",
    ],
  },
})
