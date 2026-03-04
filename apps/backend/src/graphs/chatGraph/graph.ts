import { END, MessagesZodState, START, StateGraph } from "@langchain/langgraph"
import { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres"
import "@langchain/langgraph/zod"
import { z } from "zod/v3"
import { codeInterpretter } from "./nodes/codeInterpreter.js"
import { conversationNaming } from "./nodes/conversationNaming.js"

const ChatState = MessagesZodState.extend({
  conversationName: z.string().optional(),
})

const workflow = new StateGraph(ChatState)
  .addNode("codeInterpretter", codeInterpretter)
  .addNode("conversationNaming", conversationNaming)
  .addEdge(START, "codeInterpretter")
  .addEdge(START, "conversationNaming")
  .addEdge("codeInterpretter", END)
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
