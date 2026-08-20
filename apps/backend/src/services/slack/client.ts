import type { Env } from "../../config/env.js"
import { assertNotInOrgDbContext } from "../../db/client.js"
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
  /** When set, send a JSON POST body (chat.postMessage / chat.update). */
  jsonBody?: Record<string, unknown>
}): Promise<T> {
  assertNotInOrgDbContext()
  const url = new URL(`${SLACK_API}/${input.method}`)
  for (const [key, value] of Object.entries(input.query ?? {})) {
    if (value !== undefined) url.searchParams.set(key, value)
  }

  let lastError: SlackApiError | undefined
  for (let attempt = 0; attempt < SLACK_API_MAX_ATTEMPTS; attempt += 1) {
    let res: Response
    try {
      res = await fetch(url, {
        method: input.jsonBody ? "POST" : "GET",
        headers: {
          authorization: `Bearer ${input.botToken}`,
          ...(input.jsonBody
            ? { "content-type": "application/json; charset=utf-8" }
            : {}),
        },
        body: input.jsonBody ? JSON.stringify(input.jsonBody) : undefined,
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
    botHandle: connection.botHandle,
    appId: connection.appId,
    ownerUserId: connection.ownerUserId,
    status: connection.status,
    lastEventPayload: connection.lastEventPayload,
  })
  const token = decodeSlackBotToken(stored, env)
  if (!token) throw new Error("Slack connection has no bot token")
  return token
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
    /** Stable Slack UI link (preferred for git stubs). */
    permalink?: string
    permalink_public?: string
    url_private?: string
    url_private_download?: string
  }>
}

export type SlackChannelInfo = {
  channelId: string
  name: string
  isPrivate: boolean
}

export class SlackDirectMessageNotSupportedError extends Error {
  constructor() {
    super("Slack direct messages are not supported")
    this.name = "SlackDirectMessageNotSupportedError"
  }
}

/** Resolve a human-readable channel name for git paths (ADR-025 layout). */
export async function resolveSlackChannelInfo(input: {
  env: Env
  connection: SlackConnectionShape
  channelId: string
}): Promise<SlackChannelInfo> {
  const botToken = botTokenFromConnection(input.connection, input.env)
  const page = await slackApiCall<{
    ok: boolean
    error?: string
    channel?: {
      id?: string
      name?: string
      is_private?: boolean
      is_im?: boolean
      is_mpim?: boolean
    }
  }>({
    method: "conversations.info",
    botToken,
    query: { channel: input.channelId },
  })
  if (page.channel?.is_im || page.channel?.is_mpim) {
    throw new SlackDirectMessageNotSupportedError()
  }
  const name = page.channel?.name?.trim()
  return {
    channelId: input.channelId,
    name: name && name.length > 0 ? name : input.channelId,
    isPrivate: Boolean(page.channel?.is_private),
  }
}

export const SLACK_MENTION_STATUS_WORKING = "ctx| agent working…"
export const SLACK_CAPTURE_STATUS_CAPTURED = "Engineering context captured."
export const SLACK_CAPTURE_STATUS_FAILED = "Engineering context capture failed."
export const SLACK_MENTION_CAPABILITY_REPLY =
  "I can capture this thread into your context repo. Ask me to capture it, or mention me with no extra text."

export async function postSlackThreadMessage(input: {
  env: Env
  connection: SlackConnectionShape
  channelId: string
  threadTs: string
  text: string
}): Promise<{ ts: string } | null> {
  const botToken = botTokenFromConnection(input.connection, input.env)
  try {
    const page = await slackApiCall<{
      ok: boolean
      error?: string
      ts?: string
    }>({
      method: "chat.postMessage",
      botToken,
      jsonBody: {
        channel: input.channelId,
        thread_ts: input.threadTs,
        text: input.text,
      },
    })
    if (!page.ts) return null
    return { ts: page.ts }
  } catch {
    return null
  }
}

export async function updateSlackMessage(input: {
  env: Env
  connection: SlackConnectionShape
  channelId: string
  messageTs: string
  text: string
}): Promise<boolean> {
  const botToken = botTokenFromConnection(input.connection, input.env)
  try {
    await slackApiCall<{ ok: boolean; error?: string }>({
      method: "chat.update",
      botToken,
      jsonBody: {
        channel: input.channelId,
        ts: input.messageTs,
        text: input.text,
      },
    })
    return true
  } catch {
    return false
  }
}

export const SLACK_THREAD_MAX_MESSAGES = 500

/** Bound thread snapshots so a mega-thread cannot exhaust the shared Slack app quota. */
export function capSlackThreadMessages<T>(
  messages: T[],
  hasMore: boolean,
  max = SLACK_THREAD_MAX_MESSAGES,
): { messages: T[]; truncated: boolean } {
  if (messages.length > max) {
    return { messages: messages.slice(0, max), truncated: true }
  }
  if (messages.length === max && hasMore) {
    return { messages, truncated: true }
  }
  return { messages, truncated: false }
}

export async function listSlackConversationReplies(input: {
  env: Env
  connection: SlackConnectionShape
  channelId: string
  threadTs: string
}): Promise<{ messages: SlackApiMessage[]; truncated: boolean }> {
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
    const capped = capSlackThreadMessages(messages, Boolean(cursor))
    if (capped.truncated || !cursor) {
      return capped
    }
  } while (cursor)
  return capSlackThreadMessages(messages, false)
}

export type SlackUserProfile = {
  /** Slack username without `@` (`users.info` `name`). */
  handle: string
  /** Display or real name — never a Slack user id. */
  name: string
}

function slackUserProfileFromApi(user: {
  name?: string
  real_name?: string
  profile?: { display_name?: string; real_name?: string }
}): SlackUserProfile | undefined {
  const handle = user.name?.trim()
  if (!handle || /^U[A-Z0-9]+$/i.test(handle)) return undefined
  const name =
    user.profile?.display_name?.trim() ||
    user.profile?.real_name?.trim() ||
    user.real_name?.trim() ||
    handle
  return { handle, name }
}

export async function fetchSlackUserProfile(input: {
  botToken: string
  userId: string
}): Promise<SlackUserProfile | undefined> {
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
      botToken: input.botToken,
      query: { user: input.userId },
    })
    if (!page.user) return undefined
    return slackUserProfileFromApi(page.user)
  } catch {
    return undefined
  }
}

export async function resolveSlackUserProfile(input: {
  env: Env
  connection: SlackConnectionShape
  userId: string
  cache: Map<string, SlackUserProfile>
}): Promise<SlackUserProfile | undefined> {
  const cached = input.cache.get(input.userId)
  if (cached) return cached
  const botToken = botTokenFromConnection(input.connection, input.env)
  const profile = await fetchSlackUserProfile({
    botToken,
    userId: input.userId,
  })
  if (profile) input.cache.set(input.userId, profile)
  return profile
}

export async function resolveSlackUserDisplayName(input: {
  env: Env
  connection: SlackConnectionShape
  userId: string
  cache: Map<string, string>
}): Promise<string> {
  const cached = input.cache.get(input.userId)
  if (cached) return cached
  const profileCache = new Map<string, SlackUserProfile>()
  const profile = await resolveSlackUserProfile({
    ...input,
    cache: profileCache,
  })
  const display = profile ? `${profile.name} (@${profile.handle})` : "unknown"
  input.cache.set(input.userId, display)
  return display
}

export async function getSlackPermalink(input: {
  env: Env
  connection: SlackConnectionShape
  channelId: string
  messageTs: string
}): Promise<string | undefined> {
  const botToken = botTokenFromConnection(input.connection, input.env)
  try {
    const page = await slackApiCall<{
      ok: boolean
      error?: string
      permalink?: string
    }>({
      method: "chat.getPermalink",
      botToken,
      query: {
        channel: input.channelId,
        message_ts: input.messageTs,
      },
    })
    const permalink = page.permalink?.trim()
    return permalink && permalink.length > 0 ? permalink : undefined
  } catch {
    return undefined
  }
}
