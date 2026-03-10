import { END, MessagesZodState, START, StateGraph } from "@langchain/langgraph"
import "@langchain/langgraph/zod"
import { z } from "zod/v3"
import { getModel } from "../retrieval/services/modelProvider.js"

/** MessagesZodState extended with non-message fields. Use zod/v3 to match MessagesZodState. */
const State = MessagesZodState.extend({
  step: z.number().default(0),
})

type StateType = z.infer<typeof State>

async function respond(state: StateType): Promise<Partial<StateType>> {
  const llm = getModel("fast")
  const response = await llm.invoke(state.messages)
  return {
    messages: [response],
    step: state.step + 1,
  }
}

const graph = new StateGraph(State)
  .addNode("respond", respond)
  .addEdge(START, "respond")
  .addEdge("respond", END)
  .compile()

export { graph }
