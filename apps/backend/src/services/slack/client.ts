import type { Env } from "../../config/env.js"
import {
  decodeSlackBotToken,
  parseSlackConnectionStored,
} from "../../lib/connection-config.js"
import type { SlackConnectionShape } from "../../models/connection-rows.js"
import { slackBotScopeString } from "./scopes.js"

const SLACK_API = "https://slack.com/api"

export type SlackOAuthAccessResponse = {
  ok: boolean
  error?: string
  access_token?: string
  token_type?: string
  scope?: string
  bot_user_id?: string
  app_id?: string
  team?: { id?: string; name?: string }
  authed_user?: { id?: string }
}

export type SlackChannelListItem = {
  id: string
  name: string
  isPrivate: boolean
  isMember: boolean
}

export class SlackApiError extends Error {
  readonly slackError: string
  readonly status: number
  readonly retryAfterSeconds?: number

  constructor(input: {
    slackError: string
    status: number
    retryAfterSeconds?: number
  }) {
    super(`Slack API error: ${input.slackError}`)
    this.name = "SlackApiError"
    this.slackError = input.slackError
    this.status = input.status
    this.retryAfterSeconds = input.retryAfterSeconds
  }
}

export function assertSlackOAuthConfigured(env: Env): void {
  if (!env.SLACK_CLIENT_ID || !env.SLACK_CLIENT_SECRET) {
    throw new Error("Slack OAuth is not configured")
  }
}

export function slackOAuthRedirectUri(env: Env): string {
  if (env.SLACK_REDIRECT_URI) return env.SLACK_REDIRECT_URI
  return `${env.AUTH_BASE_URL.replace(/\/$/, "")}/api/v1/connectors/slack/oauth/callback`
}

export function getSlackOAuthAuthorizeUrl(input: {
  env: Env
  state: string
}): string {
  assertSlackOAuthConfigured(input.env)
  const clientId = input.env.SLACK_CLIENT_ID
  if (!clientId) throw new Error("Slack OAuth is not configured")
  const params = new URLSearchParams({
    client_id: clientId,
    scope: slackBotScopeString(),
    redirect_uri: slackOAuthRedirectUri(input.env),
    state: input.state,
  })
  return `https://slack.com/oauth/v2/authorize?${params.toString()}`
}

export async function exchangeSlackOAuthCode(input: {
  env: Env
  code: string
}): Promise<SlackOAuthAccessResponse> {
  assertSlackOAuthConfigured(input.env)
  const body = new URLSearchParams({
    client_id: input.env.SLACK_CLIENT_ID ?? "",
    client_secret: input.env.SLACK_CLIENT_SECRET ?? "",
    code: input.code,
    redirect_uri: slackOAuthRedirectUri(input.env),
  })
  const res = await fetch(`${SLACK_API}/oauth.v2.access`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  })
  const json = (await res.json()) as SlackOAuthAccessResponse
  if (!res.ok || !json.ok || !json.access_token) {
    throw new Error(
      `Slack OAuth token exchange failed (${json.error ?? res.status})`,
    )
  }
  return json
}

const SLACK_API_MAX_ATTEMPTS = 3

async function slackApiCall<T extends { ok: boolean; error?: string }>(input: {
  method: string
  botToken: string
  query?: Record<string, string | undefined>
}): Promise<T> {
  const url = new URL(`${SLACK_API}/${input.method}`)
  for (const [key, value] of Object.entries(input.query ?? {})) {
    if (value !== undefined) url.searchParams.set(key, value)
  }

  let lastError: SlackApiError | undefined
  for (let attempt = 0; attempt < SLACK_API_MAX_ATTEMPTS; attempt += 1) {
    let res: Response
    try {
      res = await fetch(url, {
        headers: { authorization: `Bearer ${input.botToken}` },
      })
    } catch (error) {
      if (attempt >= SLACK_API_MAX_ATTEMPTS - 1) throw error
      await new Promise((resolve) => setTimeout(resolve, 250 * 2 ** attempt))
      continue
    }

    const retryAfterRaw = res.headers.get("Retry-After")
    const retryAfterSeconds =
      retryAfterRaw && /^\d+$/.test(retryAfterRaw)
        ? Number(retryAfterRaw)
        : undefined
    const json = (await res.json()) as T
    const rateLimited = res.status === 429 || json.error === "ratelimited"
    const serverError = res.status >= 500

    if ((rateLimited || serverError) && attempt < SLACK_API_MAX_ATTEMPTS - 1) {
      const delayMs = rateLimited
        ? Math.max(250, (retryAfterSeconds ?? 1) * 1000)
        : 250 * 2 ** attempt
      lastError = new SlackApiError({
        slackError: rateLimited
          ? "ratelimited"
          : (json.error ?? `http_${res.status}`),
        status: res.status,
        retryAfterSeconds,
      })
      await new Promise((resolve) => setTimeout(resolve, delayMs))
      continue
    }

    if (rateLimited) {
      throw new SlackApiError({
        slackError: "ratelimited",
        status: 429,
        retryAfterSeconds,
      })
    }
    if (!res.ok || !json.ok) {
      throw new SlackApiError({
        slackError: json.error ?? `http_${res.status}`,
        status: res.status,
      })
    }
    return json
  }

  throw lastError ?? new Error("Slack API request failed")
}

export function botTokenFromConnection(
  connection: SlackConnectionShape,
  env: Env,
): string {
  const stored = parseSlackConnectionStored({
    botTokenEnc: connection.botTokenEnc,
    teamId: connection.teamId,
    teamName: connection.teamName,
    botUserId: connection.botUserId,
    appId: connection.appId,
    ownerUserId: connection.ownerUserId,
    status: connection.status,
    lastEventPayload: connection.lastEventPayload,
  })
  const token = decodeSlackBotToken(stored, env)
  if (!token) throw new Error("Slack connection has no bot token")
  return token
}

/** List public + private channels the bot is a member of. */
export async function listSlackChannelsForBot(input: {
  env: Env
  connection: SlackConnectionShape
}): Promise<SlackChannelListItem[]> {
  const botToken = botTokenFromConnection(input.connection, input.env)
  const items: SlackChannelListItem[] = []
  let cursor: string | undefined
  do {
    const page = await slackApiCall<{
      ok: boolean
      error?: string
      channels?: Array<{
        id: string
        name?: string
        is_private?: boolean
        is_member?: boolean
      }>
      response_metadata?: { next_cursor?: string }
    }>({
      method: "conversations.list",
      botToken,
      query: {
        types: "public_channel,private_channel",
        exclude_archived: "true",
        limit: "200",
        cursor,
      },
    })
    for (const ch of page.channels ?? []) {
      if (!ch.id || ch.is_member !== true) continue
      items.push({
        id: ch.id,
        name: ch.name ?? ch.id,
        isPrivate: ch.is_private === true,
        isMember: true,
      })
    }
    const next = page.response_metadata?.next_cursor?.trim()
    cursor = next && next.length > 0 ? next : undefined
  } while (cursor)
  return items.sort((a, b) => a.name.localeCompare(b.name))
}

export type SlackApiMessage = {
  ts: string
  user?: string
  text?: string
  thread_ts?: string
  reply_count?: number
  subtype?: string
  files?: Array<{
    id: string
    name?: string
    mimetype?: string
    size?: number
    url_private_download?: string
  }>
}

export async function listSlackConversationHistory(input: {
  env: Env
  connection: SlackConnectionShape
  channelId: string
  oldest?: string
  cursor?: string
  limit?: number
}): Promise<{ messages: SlackApiMessage[]; nextCursor?: string }> {
  const botToken = botTokenFromConnection(input.connection, input.env)
  const page = await slackApiCall<{
    ok: boolean
    error?: string
    messages?: SlackApiMessage[]
    response_metadata?: { next_cursor?: string }
  }>({
    method: "conversations.history",
    botToken,
    query: {
      channel: input.channelId,
      oldest: input.oldest,
      cursor: input.cursor,
      limit: String(input.limit ?? 200),
      inclusive: "true",
    },
  })
  const next = page.response_metadata?.next_cursor?.trim()
  return {
    messages: page.messages ?? [],
    nextCursor: next && next.length > 0 ? next : undefined,
  }
}

export async function listSlackConversationReplies(input: {
  env: Env
  connection: SlackConnectionShape
  channelId: string
  threadTs: string
}): Promise<SlackApiMessage[]> {
  const botToken = botTokenFromConnection(input.connection, input.env)
  const messages: SlackApiMessage[] = []
  let cursor: string | undefined
  do {
    const page = await slackApiCall<{
      ok: boolean
      error?: string
      messages?: SlackApiMessage[]
      response_metadata?: { next_cursor?: string }
    }>({
      method: "conversations.replies",
      botToken,
      query: {
        channel: input.channelId,
        ts: input.threadTs,
        cursor,
        limit: "200",
      },
    })
    messages.push(...(page.messages ?? []))
    const next = page.response_metadata?.next_cursor?.trim()
    cursor = next && next.length > 0 ? next : undefined
  } while (cursor)
  return messages
}

export async function resolveSlackUserDisplayName(input: {
  env: Env
  connection: SlackConnectionShape
  userId: string
  cache: Map<string, string>
}): Promise<string> {
  const cached = input.cache.get(input.userId)
  if (cached) return cached
  const botToken = botTokenFromConnection(input.connection, input.env)
  try {
    const page = await slackApiCall<{
      ok: boolean
      error?: string
      user?: {
        name?: string
        real_name?: string
        profile?: { display_name?: string; real_name?: string }
      }
    }>({
      method: "users.info",
      botToken,
      query: { user: input.userId },
    })
    const display =
      page.user?.profile?.display_name ||
      page.user?.profile?.real_name ||
      page.user?.real_name ||
      page.user?.name ||
      input.userId
    input.cache.set(input.userId, display)
    return display
  } catch {
    input.cache.set(input.userId, input.userId)
    return input.userId
  }
}

export const SLACK_FILE_MAX_BYTES = 10 * 1024 * 1024

export async function downloadSlackFile(input: {
  env: Env
  connection: SlackConnectionShape
  urlPrivateDownload: string
}): Promise<{ bytes: Uint8Array; contentType?: string } | null> {
  const botToken = botTokenFromConnection(input.connection, input.env)
  const res = await fetch(input.urlPrivateDownload, {
    headers: { authorization: `Bearer ${botToken}` },
    redirect: "follow",
  })
  if (!res.ok) return null
  const buf = new Uint8Array(await res.arrayBuffer())
  if (buf.byteLength > SLACK_FILE_MAX_BYTES) return null
  return {
    bytes: buf,
    contentType: res.headers.get("content-type") ?? undefined,
  }
}
