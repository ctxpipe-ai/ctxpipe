import { getPropagatedAttributesFromContext } from "@langfuse/core"
import { context } from "@opentelemetry/api"
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node"
import { afterAll, beforeAll, expect, it } from "vitest"
import { withLangfuseTurnContext } from "../../domain/conversations/transport.js"
import { readAttribution } from "../../observability/attribution.js"
import { withSocketTurnContext } from "./conversation-websocket.js"

const provider = new NodeTracerProvider()

beforeAll(() => {
  provider.register()
})

afterAll(async () => {
  await provider.shutdown()
})

it("gives a socket turn the org, user, and conversation attribution and the Langfuse org tag", async () => {
  const seen: Array<{
    attribution: ReturnType<typeof readAttribution>
    langfuse: Record<string, unknown>
  }> = []
  const turn = withLangfuseTurnContext(
    { sessionId: "conv_ws", userId: "user_ws", source: "ui" },
    async function* () {
      seen.push({
        attribution: readAttribution(),
        langfuse: getPropagatedAttributesFromContext(context.active()),
      })
      yield { type: "RUN_FINISHED" } as never
    },
  )
  for await (const _ of withSocketTurnContext(
    { id: "org_ws", slug: "acme" },
    "user_ws",
    "conv_ws",
    turn,
  )) {
    /* drain */
  }
  expect(seen[0]?.attribution).toMatchObject({
    "ctxpipe.org.id": "org_ws",
    "ctxpipe.org.slug": "acme",
    "enduser.id": "user_ws",
    "ctxpipe.actor.type": "user",
    "ctxpipe.conversation.id": "conv_ws",
  })
  expect(seen[0]?.langfuse["langfuse.trace.tags"]).toEqual(
    expect.arrayContaining(["org:acme"]),
  )
  expect(seen[0]?.langfuse["langfuse.trace.metadata.orgId"]).toBe("org_ws")
})
