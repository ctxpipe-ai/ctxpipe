import { END, START, StateGraph } from "@langchain/langgraph"
import { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres"
import "@langchain/langgraph/zod"
import { Pool } from "pg"
import { log } from "../../observability/logger.js"
import { agentNode } from "./nodes/agent.js"
import { assembleNode } from "./nodes/assemble.js"
import { conversationNaming } from "./nodes/conversationNaming.js"
import { extractQueryNode } from "./nodes/extractQuery.js"
import { knowledgeGraphFocusNode } from "./nodes/knowledgeGraphFocus.js"
import { normalizeNode } from "./nodes/normalize.js"
import { plannerNode } from "./nodes/planner.js"
import { rerankNode } from "./nodes/rerank.js"
import { retrievalChannelsNode } from "./nodes/retrievalChannels.js"
import { ConversationGraphStateSchema } from "./state.js"

const workflow = new StateGraph(ConversationGraphStateSchema)
  .addNode("extractQuery", extractQueryNode)
  .addNode("planner", plannerNode)
  .addNode("retrievalChannels", retrievalChannelsNode)
  .addNode("normalize", normalizeNode)
  .addNode("rerank", rerankNode)
  .addNode("knowledgeGraphFocus", knowledgeGraphFocusNode)
  .addNode("assemble", assembleNode)
  .addNode("agent", agentNode)
  .addNode("conversationNaming", conversationNaming)

  .addEdge(START, "extractQuery")
  .addEdge(START, "conversationNaming")

  .addEdge("extractQuery", "planner")

  .addEdge("planner", "retrievalChannels")

  .addEdge("retrievalChannels", "normalize")

  .addEdge("normalize", "rerank")
  .addEdge("rerank", "knowledgeGraphFocus")
  .addEdge("knowledgeGraphFocus", "assemble")
  .addEdge("assemble", "agent")
  .addEdge("agent", END)
  .addEdge("conversationNaming", END)

let checkpointer: PostgresSaver | undefined
if (process.env.DATABASE_URL) {
  const isPrPreview = Boolean(
    process.env.RAILWAY_ENVIRONMENT_NAME?.trim().startsWith("pr-"),
  )
  // keepAlive + long-lived pools block Railway Serverless (outbound resets the
  // 10m idle timer). PR previews close idle clients quickly with keepAlive off.
  const checkpointPool = new Pool({
    connectionString: process.env.DATABASE_URL,
    max: isPrPreview ? 2 : 10,
    keepAlive: !isPrPreview,
    idleTimeoutMillis: isPrPreview ? 10_000 : 30_000,
    allowExitOnIdle: isPrPreview,
    connectionTimeoutMillis: 5_000,
    application_name: "ctxpipe-checkpointer",
  })
  checkpointPool.on("error", (err) => {
    log.error({
      step: "conversation.checkpointer_pool",
      message: "Checkpointer pg pool error",
      error: err instanceof Error ? err.message : String(err),
    })
  })
  checkpointer = new PostgresSaver(checkpointPool)
  // DDL is owner-only (`migrate-checkpoints.ts`). CREATE SCHEMA as
  // ctxpipe_app is "permission denied for database".
}

const graph = checkpointer
  ? workflow.compile({ checkpointer })
  : workflow.compile()

export { graph as conversationGraph }
