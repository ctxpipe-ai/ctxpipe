import { ow } from "./client.js"
import { helloWorld } from "./hello-world.js"

const handle = await ow.runWorkflow(helloWorld.spec, {})
console.log("Workflow run enqueued:", handle.workflowRun.id)
const result = await handle.result()
console.log("Workflow completed:", result)
