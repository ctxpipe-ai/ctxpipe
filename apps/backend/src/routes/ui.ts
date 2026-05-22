import type { Hono } from "hono"
import { proxy } from "hono/proxy"
import type { AppEnv } from "../app/env.js"
import type { Env } from "../config/env.js"

type UiProxyClientMessage = string | ArrayBuffer | Uint8Array

export type UiProxyWebSocketData = {
  upstream: WebSocket
  pendingMessages: UiProxyClientMessage[]
}

type UiProxyUpgradeServer = {
  upgrade: (
    request: Request,
    options: { data: UiProxyWebSocketData },
  ) => boolean
}

type UiProxyServerSocket = {
  data: UiProxyWebSocketData
  readyState: number
  send: (data: UiProxyClientMessage) => void
  close: (code?: number, reason?: string) => void
}

const VITE_WS_PROTOCOLS = new Set(["vite-hmr", "vite-ping"])

export function registerUiRoutes(app: Hono<AppEnv>, env: Env) {
  app.all("*", async (c) => {
    const sourceUrl = new URL(c.req.url)
    const upstreamUrl = new URL(
      `${sourceUrl.pathname}${sourceUrl.search}`,
      env.UI_PROXY_URL,
    )
    const headers = new Headers(c.req.raw.headers)
    headers.set("Host", upstreamUrl.host)
    return proxy(upstreamUrl, {
      raw: c.req.raw,
      headers: Object.fromEntries(headers),
      redirect: "follow",
    })
  })
  return app
}

export function handleWebSocketProxy(
  request: Request,
  server: UiProxyUpgradeServer,
  env: Env,
): Response | undefined {
  if (!isViteHmrWebSocketRequest(request, env.NODE_ENV)) {
    return undefined
  }

  const protocols = (request.headers.get("sec-websocket-protocol") ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean)

  const sourceUrl = new URL(request.url)
  const upstreamUrl = new URL(
    `${sourceUrl.pathname}${sourceUrl.search}`,
    env.UI_PROXY_URL,
  )
  upstreamUrl.protocol = upstreamUrl.protocol === "https:" ? "wss:" : "ws:"

  const upstream = new WebSocket(upstreamUrl, protocols)
  upstream.binaryType = "arraybuffer"

  const upgraded = server.upgrade(request, {
    data: { upstream, pendingMessages: [] },
  })
  if (!upgraded) {
    if (isWsCloseable(upstream))
      upstream.close(1011, "Backend websocket upgrade failed")
    return new Response("WebSocket upgrade failed", { status: 500 })
  }

  return undefined
}

export const uiProxyWebSocketHandlers = {
  open(ws: UiProxyServerSocket) {
    ws.data.upstream.onopen = () => {
      flushPendingMessages(ws)
    }
    ws.data.upstream.onmessage = (event) => {
      const isValidPayload =
        typeof event.data === "string" ||
        event.data instanceof ArrayBuffer ||
        event.data instanceof Uint8Array
      if (!isValidPayload || ws.readyState !== WebSocket.OPEN) return
      ws.send(event.data)
    }
    ws.data.upstream.onclose = (event) => {
      if (isWsCloseable(ws.data.upstream))
        ws.data.upstream.close(event.code, event.reason)
    }
    ws.data.upstream.onerror = () => {
      if (isWsCloseable(ws.data.upstream))
        ws.data.upstream.close(1011, "Upstream websocket error")
    }
    if (ws.data.upstream.readyState === WebSocket.OPEN) {
      flushPendingMessages(ws)
    }
  },

  message(ws: UiProxyServerSocket, message: UiProxyClientMessage) {
    if (ws.data.upstream.readyState === WebSocket.CONNECTING) {
      ws.data.pendingMessages.push(message)
      return
    }
    if (ws.data.upstream.readyState !== WebSocket.OPEN) return
    ws.data.upstream.send(message)
  },

  close(ws: UiProxyServerSocket, code: number, reason: string) {
    if (isWsCloseable(ws.data.upstream)) ws.data.upstream.close(code, reason)
  },
}

function isWsCloseable(ws: WebSocket): boolean {
  return (
    ws.readyState !== WebSocket.CLOSING && ws.readyState !== WebSocket.CLOSED
  )
}

export function isViteHmrWebSocketRequest(
  request: Request,
  nodeEnv: Env["NODE_ENV"],
): boolean {
  if (nodeEnv !== "development") return false

  const upgrade = request.headers.get("upgrade")
  if (upgrade?.toLowerCase() !== "websocket") return false

  const connection = request.headers.get("connection")
  if (!connection) return false
  const isConnectionUpgrade = connection
    .toLowerCase()
    .split(",")
    .map((value) => value.trim())
    .includes("upgrade")
  if (!isConnectionUpgrade) return false

  const protocols = request.headers.get("sec-websocket-protocol")
  if (!protocols) return false

  return protocols
    .split(",")
    .some((protocol) => VITE_WS_PROTOCOLS.has(protocol.trim().toLowerCase()))
}

function flushPendingMessages(ws: UiProxyServerSocket): void {
  if (ws.data.upstream.readyState !== WebSocket.OPEN) return
  if (ws.data.pendingMessages.length === 0) return
  for (const pendingMessage of ws.data.pendingMessages) {
    ws.data.upstream.send(pendingMessage)
  }
  ws.data.pendingMessages.length = 0
}
