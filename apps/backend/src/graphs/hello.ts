import type { BaseMessage } from "@langchain/core/messages"
import { Annotation, StateGraph, START, END } from "@langchain/langgraph"
import { getModel } from "../config/models.js"

const State = Annotation.Root({
  messages: Annotation<BaseMessage[]>({
    reducer: (curr, update) => curr.concat(update),
    default: () => [],
  }),
})

async function respond(
  state: typeof State.State
): Promise<Partial<typeof State.State>> {
  const llm = getModel("fast")
  const response = await llm.invoke(state.messages)
  return { messages: [response] }
}

const graph = new StateGraph(State)
  .addNode("respond", respond)
  .addEdge(START, "respond")
  .addEdge("respond", END)
  .compile()

export { graph }
