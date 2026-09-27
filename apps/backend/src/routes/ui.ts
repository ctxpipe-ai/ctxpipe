import type { Context, Hono } from "hono"
import { proxy } from "hono/proxy"
import type { AppEnv } from "../app/env.js"
import type { Env } from "../config/env.js"

type UiProxyClientMessage = string | ArrayBuffer | Uint8Array

export const UI_PROXY_TIMEOUT_MS = 15_000

export function isUiProxyAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError"
}

export type UiProxyOriginTrust = {
  publicOrigin: string
  allowedOrigins?: string
}

export async function proxyUiRequest(
  request: Request,
  uiProxyUrl: string,
  timeoutMs = UI_PROXY_TIMEOUT_MS,
  originTrust: UiProxyOriginTrust,
): Promise<Response> {
  const sourceUrl = new URL(request.url)
  const upstreamUrl = new URL(
    `${sourceUrl.pathname}${sourceUrl.search}`,
    uiProxyUrl,
  )
  const headers = uiProxyUpstreamHeaders(
    request.headers,
    upstreamUrl.host,
    originTrust,
  )
  const timeout = AbortSignal.timeout(timeoutMs)
  const signal =
    typeof AbortSignal.any === "function"
      ? AbortSignal.any([request.signal, timeout])
      : timeout
  try {
    return await proxy(upstreamUrl, {
      raw: request,
      headers: Object.fromEntries(headers),
      redirect: "follow",
      signal,
    })
  } catch (error) {
    if (
      isUiProxyAbortError(error) ||
      timeout.aborted ||
      request.signal.aborted
    ) {
      return new Response("Gateway Timeout", { status: 504 })
    }
    return new Response("Bad Gateway", { status: 502 })
  }
}

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

/**
 * The UI service is private. Tell it the public origin the browser used so
 * `/.otel` can check Origin against the site, not the TLS-terminated hop
 * (`http://…` behind Railway) or a client-supplied forwarded host.
 */
export function uiProxyUpstreamHeaders(
  incoming: Headers,
  upstreamHost: string,
  originTrust: UiProxyOriginTrust,
): Headers {
  const headers = new Headers(incoming)
  const publicOrigin = resolvePublicForwardedOrigin(incoming, originTrust)
  headers.set("x-forwarded-host", publicOrigin.host)
  headers.set("x-forwarded-proto", publicOrigin.proto)
  headers.set("host", upstreamHost)
  return headers
}

function parseHttpOrigin(value: string): URL | null {
  try {
    const url = new URL(value)
    if (url.protocol !== "http:" && url.protocol !== "https:") return null
    return url
  } catch {
    return null
  }
}

function trustedOrigins(originTrust: UiProxyOriginTrust): Set<string> {
  const trusted = new Set<string>()
  const configured = parseHttpOrigin(originTrust.publicOrigin)
  if (configured) trusted.add(configured.origin)
  for (const part of (originTrust.allowedOrigins ?? "").split(",")) {
    const allowed = parseHttpOrigin(part.trim())
    if (allowed) trusted.add(allowed.origin)
  }
  return trusted
}

function resolvePublicForwardedOrigin(
  incoming: Headers,
  originTrust: UiProxyOriginTrust,
): { host: string; proto: "http" | "https" } {
  const trusted = trustedOrigins(originTrust)
  const originHeader = incoming.get("origin")
  if (originHeader && trusted.has(originHeader)) {
    const origin = new URL(originHeader)
    return {
      host: origin.host,
      proto: origin.protocol === "https:" ? "https" : "http",
    }
  }
  const configured = parseHttpOrigin(originTrust.publicOrigin)
  if (!configured) throw new Error("AUTH_BASE_URL must be an HTTP origin")
  return {
    host: configured.host,
    proto: configured.protocol === "https:" ? "https" : "http",
  }
}

export function registerUiRoutes(app: Hono<AppEnv>, env: Env) {
  const originTrust: UiProxyOriginTrust = {
    publicOrigin: env.AUTH_BASE_URL,
    allowedOrigins: env.AUTH_ALLOWED_ORIGINS,
  }
  const handler = (c: Context<AppEnv>) =>
    proxyUiRequest(
      c.req.raw,
      env.UI_PROXY_URL,
      UI_PROXY_TIMEOUT_MS,
      originTrust,
    )
  // Registered before the catch-all so Hono reports `/.otel/v1/:signal`.
  app.all("/.otel/v1/:signal", handler)
  app.all("*", handler)
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
