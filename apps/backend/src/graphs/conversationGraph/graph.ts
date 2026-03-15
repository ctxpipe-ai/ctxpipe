import { END, START, StateGraph } from "@langchain/langgraph"
import { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres"
import "@langchain/langgraph/zod"
import { conversationNaming } from "./nodes/conversationNaming.js"
import { agentNode } from "./nodes/agent.js"
import { assembleNode } from "./nodes/assemble.js"
import { extractQueryNode } from "./nodes/extractQuery.js"
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
  .addNode("assemble", assembleNode)
  .addNode("agent", agentNode)
  .addNode("conversationNaming", conversationNaming)

  .addEdge(START, "extractQuery")
  .addEdge(START, "conversationNaming")

  .addEdge("extractQuery", "planner")

  .addEdge("planner", "retrievalChannels")

  .addEdge("retrievalChannels", "normalize")

  .addEdge("normalize", "rerank")
  .addEdge("rerank", "assemble")
  .addEdge("assemble", "agent")
  .addEdge("agent", END)
  .addEdge("conversationNaming", END)

const checkpointer = process.env.DATABASE_URL
  ? PostgresSaver.fromConnString(process.env.DATABASE_URL)
  : undefined

if (checkpointer) {
  await checkpointer.setup()
}

const graph = checkpointer
  ? workflow.compile({ checkpointer })
  : workflow.compile()

export { graph as conversationGraph }
