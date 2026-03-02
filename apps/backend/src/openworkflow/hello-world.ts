import { defineWorkflow } from "openworkflow"

export const helloWorld = defineWorkflow(
  { name: "hello-world" },
  async ({ step }) => {
    const greeting = await step.run({ name: "create-greeting" }, async () => {
      return "Hello, World!"
    })

    await step.run({ name: "log-greeting" }, async () => {
      console.log(greeting)
      return { logged: true }
    })

    return { message: greeting }
  },
)
