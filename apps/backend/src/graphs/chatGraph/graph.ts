import { END, MessagesZodState, START, StateGraph } from "@langchain/langgraph"
import { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres"
import "@langchain/langgraph/zod"
import { codeInterpretter } from "./nodes/codeInterpreter.js"

const workflow = new StateGraph(MessagesZodState)
  .addNode("codeInterpretter", codeInterpretter)
  .addEdge(START, "codeInterpretter")
  .addEdge("codeInterpretter", END)

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
