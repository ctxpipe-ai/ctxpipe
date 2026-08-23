import type { Serve } from "bun"
import { createApp } from "./app/app.js"
import { parseEnv } from "./config/env.js"
import { closeDb } from "./db/client.js"
import { flushEvlog, initEvlog } from "./observability/logger.js"
import { initOtel, shutdownOtel } from "./observability/otel.js"
import { shutdownGraphClients } from "./platform/graph/index.js"
import {
  conversationWebSocketHandlers,
  handleConversationWebSocket,
  isWorkspaceChatWebSocketRequest,
  type ConversationWebSocketData,
} from "./routes/v1/conversation-websocket.js"
import {
  handleWebSocketProxy,
  type UiProxyWebSocketData,
  uiProxyWebSocketHandlers,
} from "./routes/ui.js"

const env = parseEnv(process.env as Record<string, string | undefined>)
initOtel(env)
initEvlog()
const app = createApp()
let shuttingDown = false

async function shutdownResources() {
  if (shuttingDown) return
  shuttingDown = true
  await Promise.all([flushEvlog(), shutdownOtel()])
  await shutdownGraphClients()
  await closeDb()
}

process.on("SIGINT", () => {
  void shutdownResources()
})

process.on("SIGTERM", () => {
  void shutdownResources()
})

type ServerSocketData = ConversationWebSocketData | UiProxyWebSocketData

function isWorkspaceChatSocketData(
  data: ServerSocketData,
): data is ConversationWebSocketData {
  return "kind" in data && data.kind === "workspace-chat"
}

export default {
  port: env.PORT,
  idleTimeout: 255,
  fetch: async (request, server) => {
    if (isWorkspaceChatWebSocketRequest(request)) {
      return handleConversationWebSocket(request, server)
    }
    return (
      handleWebSocketProxy(request, server, env) || app.fetch(request, server)
    )
  },
  websocket: {
    open(ws) {
      if (isWorkspaceChatSocketData(ws.data)) {
        conversationWebSocketHandlers.open(
          ws as unknown as Parameters<
            typeof conversationWebSocketHandlers.open
          >[0],
        )
        return
      }
      uiProxyWebSocketHandlers.open(
        ws as unknown as Parameters<typeof uiProxyWebSocketHandlers.open>[0],
      )
    },
    message(ws, message) {
      if (isWorkspaceChatSocketData(ws.data)) {
        void conversationWebSocketHandlers.message(
          ws as unknown as Parameters<
            typeof conversationWebSocketHandlers.message
          >[0],
          message,
        )
        return
      }
      uiProxyWebSocketHandlers.message(
        ws as unknown as Parameters<typeof uiProxyWebSocketHandlers.message>[0],
        message,
      )
    },
    close(ws, code, reason) {
      if (isWorkspaceChatSocketData(ws.data)) {
        conversationWebSocketHandlers.close(
          ws as unknown as Parameters<
            typeof conversationWebSocketHandlers.close
          >[0],
        )
        return
      }
      uiProxyWebSocketHandlers.close(
        ws as unknown as Parameters<typeof uiProxyWebSocketHandlers.close>[0],
        code,
        reason,
      )
    },
  },
} satisfies Serve.Options<ServerSocketData>
