import { END, MessagesZodState, START, StateGraph } from "@langchain/langgraph"
import { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres"
import "@langchain/langgraph/zod"
import { z } from "zod/v3"
import { conversationNaming } from "./nodes/conversationNaming.js"
import { retrievalNode } from "./nodes/retrievalNode.js"

const ChatState = MessagesZodState.extend({
  conversationName: z.string().optional(),
})

const workflow = new StateGraph(ChatState)
  .addNode("retrieval", retrievalNode)
  .addNode("conversationNaming", conversationNaming)
  .addEdge(START, "retrieval")
  .addEdge(START, "conversationNaming")
  .addEdge("retrieval", END)
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

export { graph }
