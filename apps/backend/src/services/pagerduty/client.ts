import { createHash, randomBytes } from "node:crypto"
import type { Env } from "../../config/env.js"
import type { PagerdutyRegion } from "../../lib/connection-config.js"
import {
  PAGERDUTY_INCIDENT_LOOKBACK_DAYS,
  PAGERDUTY_MAX_INCIDENTS_PER_SERVICE,
} from "./limits.js"
import type {
  PagerdutyAlertForMirror,
  PagerdutyIncidentForMirror,
  PagerdutyNoteForMirror,
} from "./converter.js"

export const PAGERDUTY_OAUTH_SCOPES = [
  "incidents.read",
  "services.read",
  "users.read",
  "webhook_subscriptions.read",
  "webhook_subscriptions.write",
] as const

export const PAGERDUTY_INCIDENT_WEBHOOK_EVENTS = [
  "incident.acknowledged",
  "incident.annotated",
  "incident.delegated",
  "incident.escalated",
  "incident.priority_updated",
  "incident.reassigned",
  "incident.reopened",
  "incident.resolved",
  "incident.responder.added",
  "incident.responder.replied",
  "incident.status_update_published",
  "incident.triggered",
  "incident.unacknowledged",
] as const

export function pagerdutyApiBaseUrl(region: PagerdutyRegion): string {
  return region === "eu"
    ? "https://api.eu.pagerduty.com"
    : "https://api.pagerduty.com"
}

export function pagerdutyRedirectUri(env: Env): string {
  return (
    env.PAGERDUTY_REDIRECT_URI ??
    `${env.AUTH_BASE_URL.replace(/\/$/, "")}/api/v1/integrations/pagerduty/callback`
  )
}

export function createPagerdutyPkcePair(): {
  codeVerifier: string
  codeChallenge: string
} {
  const codeVerifier = randomBytes(32).toString("base64url")
  const codeChallenge = createHash("sha256")
    .update(codeVerifier)
    .digest("base64url")
  return { codeVerifier, codeChallenge }
}

export function getPagerdutyOAuthAuthorizeUrl(input: {
  env: Env
  state: string
  codeChallenge: string
}): string {
  if (!input.env.PAGERDUTY_CLIENT_ID || !input.env.PAGERDUTY_CLIENT_SECRET) {
    throw new Error("PagerDuty OAuth is not configured")
  }
  const url = new URL("https://identity.pagerduty.com/oauth/authorize")
  url.searchParams.set("client_id", input.env.PAGERDUTY_CLIENT_ID)
  url.searchParams.set("redirect_uri", pagerdutyRedirectUri(input.env))
  url.searchParams.set("response_type", "code")
  url.searchParams.set("scope", PAGERDUTY_OAUTH_SCOPES.join(" "))
  url.searchParams.set("state", input.state)
  url.searchParams.set("code_challenge", input.codeChallenge)
  url.searchParams.set("code_challenge_method", "S256")
  return url.toString()
}

export function pagerdutyTokenExpiresAt(
  expiresIn: number | undefined,
  now = Date.now(),
): string | null {
  if (!expiresIn || expiresIn <= 0) return null
  return new Date(now + expiresIn * 1000).toISOString()
}

type TokenResponse = {
  access_token: string
  refresh_token?: string
  expires_in?: number
}

async function exchangePagerdutyToken(
  env: Env,
  body: URLSearchParams,
): Promise<TokenResponse> {
  if (!env.PAGERDUTY_CLIENT_ID || !env.PAGERDUTY_CLIENT_SECRET) {
    throw new Error("PagerDuty OAuth is not configured")
  }
  body.set("client_id", env.PAGERDUTY_CLIENT_ID)
  body.set("client_secret", env.PAGERDUTY_CLIENT_SECRET)
  const response = await fetch("https://identity.pagerduty.com/oauth/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  })
  if (!response.ok) {
    throw new Error(`PagerDuty token exchange failed (${response.status})`)
  }
  return (await response.json()) as TokenResponse
}

export async function exchangePagerdutyOAuthCode(input: {
  env: Env
  code: string
  codeVerifier: string
}): Promise<{
  accessToken: string
  refreshToken: string | null
  accessTokenExpiresAt: string | null
}> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: input.code,
    redirect_uri: pagerdutyRedirectUri(input.env),
    code_verifier: input.codeVerifier,
  })
  const token = await exchangePagerdutyToken(input.env, body)
  return {
    accessToken: token.access_token,
    refreshToken: token.refresh_token ?? null,
    accessTokenExpiresAt: pagerdutyTokenExpiresAt(token.expires_in),
  }
}

export async function refreshPagerdutyOAuthToken(input: {
  env: Env
  refreshToken: string
}): Promise<{
  accessToken: string
  refreshToken: string | null
  accessTokenExpiresAt: string | null
}> {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: input.refreshToken,
  })
  const token = await exchangePagerdutyToken(input.env, body)
  return {
    accessToken: token.access_token,
    refreshToken: token.refresh_token ?? input.refreshToken,
    accessTokenExpiresAt: pagerdutyTokenExpiresAt(token.expires_in),
  }
}

async function pagerdutyFetch(input: {
  region: PagerdutyRegion
  accessToken: string
  path: string
  method?: string
  search?: URLSearchParams
  json?: unknown
}): Promise<Response> {
  const url = new URL(input.path, `${pagerdutyApiBaseUrl(input.region)}/`)
  if (input.search) url.search = input.search.toString()
  let attempt = 0
  while (true) {
    const response = await fetch(url, {
      method: input.method ?? "GET",
      headers: {
        accept: "application/vnd.pagerduty+json;version=2",
        authorization: `Bearer ${input.accessToken}`,
        ...(input.json ? { "content-type": "application/json" } : {}),
      },
      body: input.json ? JSON.stringify(input.json) : undefined,
    })
    if (response.status === 429 && attempt < 4) {
      const retryAfter = Number(response.headers.get("retry-after"))
      const delayMs = Number.isFinite(retryAfter)
        ? retryAfter * 1000
        : 500 * 2 ** attempt
      await new Promise((resolve) => setTimeout(resolve, delayMs))
      attempt += 1
      continue
    }
    return response
  }
}

function referenceName(value: unknown): string | null {
  if (!value || typeof value !== "object") return null
  const record = value as Record<string, unknown>
  return typeof record.summary === "string" ? record.summary : null
}

function referenceUrl(value: unknown): string | null {
  if (!value || typeof value !== "object") return null
  const record = value as Record<string, unknown>
  return typeof record.html_url === "string" ? record.html_url : null
}

function referenceId(value: unknown): string | null {
  if (!value || typeof value !== "object") return null
  const record = value as Record<string, unknown>
  return typeof record.id === "string" ? record.id : null
}

export function pagerdutyRegionFromHtmlUrl(htmlUrl: string): PagerdutyRegion {
  return htmlUrl.includes(".eu.pagerduty.com") ? "eu" : "us"
}

export function pagerdutySubdomainFromHtmlUrl(
  htmlUrl: string,
): string | undefined {
  try {
    const host = new URL(htmlUrl).hostname
    const match = host.match(/^([a-z0-9-]+)\.(?:eu\.)?pagerduty\.com$/i)
    return match?.[1]
  } catch {
    return undefined
  }
}

export type PagerdutyAccountIdentity = {
  accountId: string
  accountName: string
  accountSubdomain: string
  region: PagerdutyRegion
  actorUserId: string | null
}

export function pagerdutyWebhookDeliveryUrl(env: Env): string {
  return `${env.AUTH_BASE_URL.replace(/\/$/, "")}/api/v1/webhook/pagerduty`
}

async function identityFromServiceList(
  accessToken: string,
  region: PagerdutyRegion,
): Promise<PagerdutyAccountIdentity | null> {
  const listed = await listPagerdutyServices({
    accessToken,
    region,
    limit: 1,
  })
  const first = listed.services[0]
  if (!first?.url) return null
  const subdomain = pagerdutySubdomainFromHtmlUrl(first.url)
  if (!subdomain) return null
  return {
    accountId: subdomain,
    accountName: first.name || subdomain,
    accountSubdomain: subdomain,
    region: pagerdutyRegionFromHtmlUrl(first.url),
    actorUserId: null,
  }
}

export async function getPagerdutyAccountIdentity(input: {
  accessToken: string
  regionHint?: PagerdutyRegion
}): Promise<PagerdutyAccountIdentity> {
  const order: PagerdutyRegion[] =
    input.regionHint === "eu" ? ["eu", "us"] : ["us", "eu"]
  let lastError: Error | undefined
  for (const region of order) {
    const response = await pagerdutyFetch({
      region,
      accessToken: input.accessToken,
      path: "/users/me",
    })
    if (!response.ok) {
      lastError = new Error(
        `PagerDuty identity lookup failed (${response.status})`,
      )
      continue
    }
    const body = (await response.json()) as {
      user?: { id?: string; html_url?: string; name?: string }
    }
    const htmlUrl = body.user?.html_url ?? ""
    const detectedRegion = htmlUrl
      ? pagerdutyRegionFromHtmlUrl(htmlUrl)
      : region
    const subdomain = pagerdutySubdomainFromHtmlUrl(htmlUrl)
    if (!subdomain) {
      lastError = new Error(
        "PagerDuty account subdomain was not present on /users/me",
      )
      continue
    }
    return {
      accountId: subdomain,
      accountName: subdomain,
      accountSubdomain: subdomain,
      region: detectedRegion,
      actorUserId: typeof body.user?.id === "string" ? body.user.id : null,
    }
  }
  // Scoped App / account-level tokens cannot call /users/me. services.read can
  // still name the account from a service permalink.
  for (const region of order) {
    try {
      const fromService = await identityFromServiceList(
        input.accessToken,
        region,
      )
      if (fromService) return fromService
    } catch (error) {
      lastError =
        error instanceof Error
          ? error
          : new Error("PagerDuty service list failed")
    }
  }
  throw (
    lastError ??
    new Error(
      "PagerDuty identity lookup failed. Add users.read on the Scoped OAuth app, or ensure the account has at least one service.",
    )
  )
}

export type PagerdutyServiceSummary = {
  id: string
  name: string
  url?: string
}

export async function listPagerdutyServices(input: {
  accessToken: string
  region: PagerdutyRegion
  query?: string
  offset?: number
  limit?: number
}): Promise<{
  services: PagerdutyServiceSummary[]
  more: boolean
}> {
  const search = new URLSearchParams({
    limit: String(input.limit ?? 25),
    offset: String(input.offset ?? 0),
    sort_by: "name",
  })
  if (input.query?.trim()) search.set("query", input.query.trim())
  const response = await pagerdutyFetch({
    region: input.region,
    accessToken: input.accessToken,
    path: "/services",
    search,
  })
  if (!response.ok) {
    throw new Error(`PagerDuty service list failed (${response.status})`)
  }
  const body = (await response.json()) as {
    services?: Array<{ id?: string; name?: string; html_url?: string }>
    more?: boolean
  }
  return {
    more: Boolean(body.more),
    services: (body.services ?? [])
      .filter(
        (service): service is { id: string; name: string; html_url?: string } =>
          typeof service.id === "string" && typeof service.name === "string",
      )
      .map((service) => ({
        id: service.id,
        name: service.name,
        url: service.html_url,
      })),
  }
}

function mapAlert(raw: Record<string, unknown>): PagerdutyAlertForMirror {
  const body =
    raw.body && typeof raw.body === "object"
      ? (raw.body as Record<string, unknown>)
      : {}
  const details =
    body.details && typeof body.details === "object"
      ? (body.details as Record<string, unknown>)
      : body.cef_details && typeof body.cef_details === "object"
        ? (body.cef_details as Record<string, unknown>)
        : null
  const contexts = Array.isArray(body.contexts)
    ? body.contexts.flatMap((context) => {
        if (!context || typeof context !== "object") return []
        const record = context as Record<string, unknown>
        return [
          {
            type: typeof record.type === "string" ? record.type : "link",
            href: typeof record.href === "string" ? record.href : undefined,
            src: typeof record.src === "string" ? record.src : undefined,
            text: typeof record.text === "string" ? record.text : undefined,
          },
        ]
      })
    : []
  return {
    id: String(raw.id ?? ""),
    summary: typeof raw.summary === "string" ? raw.summary : "Alert",
    severity: typeof raw.severity === "string" ? raw.severity : null,
    status: typeof raw.status === "string" ? raw.status : null,
    createdAt: typeof raw.created_at === "string" ? raw.created_at : null,
    alertKey: typeof raw.alert_key === "string" ? raw.alert_key : null,
    integrationName: referenceName(raw.integration),
    details,
    contexts,
  }
}

function mapIncident(
  raw: Record<string, unknown>,
  alerts: PagerdutyAlertForMirror[],
  notes: PagerdutyNoteForMirror[],
): PagerdutyIncidentForMirror {
  const serviceId = referenceId(raw.service)
  if (!serviceId) throw new Error("PagerDuty incident is missing a service")
  const assignees = Array.isArray(raw.assignments)
    ? raw.assignments
    : Array.isArray(raw.assignees)
      ? raw.assignees
      : []
  const firstAssignee = assignees[0]
  const assignee =
    firstAssignee && typeof firstAssignee === "object"
      ? ((firstAssignee as { assignee?: unknown }).assignee ?? firstAssignee)
      : null
  const teams = Array.isArray(raw.teams) ? raw.teams[0] : null
  return {
    id: String(raw.id ?? ""),
    number: typeof raw.incident_number === "number" ? raw.incident_number : 0,
    title:
      typeof raw.title === "string"
        ? raw.title
        : typeof raw.summary === "string"
          ? raw.summary
          : "Incident",
    htmlUrl:
      typeof raw.html_url === "string" ? raw.html_url : "",
    status: typeof raw.status === "string" ? raw.status : "unknown",
    urgency: typeof raw.urgency === "string" ? raw.urgency : null,
    priority: referenceName(raw.priority),
    createdAt: typeof raw.created_at === "string" ? raw.created_at : null,
    updatedAt: typeof raw.updated_at === "string" ? raw.updated_at : null,
    serviceId,
    serviceName: referenceName(raw.service),
    serviceUrl: referenceUrl(raw.service) ?? undefined,
    assigneeName: referenceName(assignee),
    assigneeUrl: referenceUrl(assignee) ?? undefined,
    escalationPolicyName: referenceName(raw.escalation_policy),
    escalationPolicyUrl: referenceUrl(raw.escalation_policy) ?? undefined,
    teamName: referenceName(teams),
    teamUrl: referenceUrl(teams) ?? undefined,
    alerts,
    notes,
  }
}

export async function listPagerdutyIncidentIdsForService(input: {
  accessToken: string
  region: PagerdutyRegion
  serviceId: string
  now?: Date
}): Promise<string[]> {
  const until = input.now ?? new Date()
  const since = new Date(
    until.getTime() - PAGERDUTY_INCIDENT_LOOKBACK_DAYS * 24 * 60 * 60 * 1000,
  )
  const ids: string[] = []
  let offset = 0
  while (ids.length < PAGERDUTY_MAX_INCIDENTS_PER_SERVICE) {
    const search = new URLSearchParams({
      limit: "100",
      offset: String(offset),
      sort_by: "created_at:desc",
      since: since.toISOString(),
      until: until.toISOString(),
    })
    search.append("service_ids[]", input.serviceId)
    const response = await pagerdutyFetch({
      region: input.region,
      accessToken: input.accessToken,
      path: "/incidents",
      search,
    })
    if (!response.ok) {
      throw new Error(`PagerDuty incident list failed (${response.status})`)
    }
    const body = (await response.json()) as {
      incidents?: Array<{ id?: string }>
      more?: boolean
    }
    const page = (body.incidents ?? [])
      .map((incident) => incident.id)
      .filter((id): id is string => typeof id === "string")
    ids.push(...page)
    if (!body.more || page.length === 0) break
    offset += page.length
  }
  return ids.slice(0, PAGERDUTY_MAX_INCIDENTS_PER_SERVICE)
}

export async function getPagerdutyIncident(input: {
  accessToken: string
  region: PagerdutyRegion
  incidentId: string
}): Promise<PagerdutyIncidentForMirror | "not_found"> {
  const response = await pagerdutyFetch({
    region: input.region,
    accessToken: input.accessToken,
    path: `/incidents/${encodeURIComponent(input.incidentId)}`,
  })
  if (response.status === 404) return "not_found"
  if (!response.ok) {
    throw new Error(`PagerDuty incident get failed (${response.status})`)
  }
  const body = (await response.json()) as { incident?: Record<string, unknown> }
  if (!body.incident) return "not_found"
  const [alerts, notes] = await Promise.all([
    listPagerdutyIncidentAlerts(input),
    listPagerdutyIncidentNotes(input),
  ])
  return mapIncident(body.incident, alerts, notes)
}

async function listPagerdutyIncidentAlerts(input: {
  accessToken: string
  region: PagerdutyRegion
  incidentId: string
}): Promise<PagerdutyAlertForMirror[]> {
  const search = new URLSearchParams({ limit: "100", sort_by: "created_at:asc" })
  const response = await pagerdutyFetch({
    region: input.region,
    accessToken: input.accessToken,
    path: `/incidents/${encodeURIComponent(input.incidentId)}/alerts`,
    search,
  })
  if (!response.ok) {
    throw new Error(`PagerDuty alert list failed (${response.status})`)
  }
  const body = (await response.json()) as {
    alerts?: Array<Record<string, unknown>>
  }
  return (body.alerts ?? []).map(mapAlert).filter((alert) => alert.id)
}

async function listPagerdutyIncidentNotes(input: {
  accessToken: string
  region: PagerdutyRegion
  incidentId: string
}): Promise<PagerdutyNoteForMirror[]> {
  const response = await pagerdutyFetch({
    region: input.region,
    accessToken: input.accessToken,
    path: `/incidents/${encodeURIComponent(input.incidentId)}/notes`,
  })
  if (!response.ok) {
    throw new Error(`PagerDuty notes list failed (${response.status})`)
  }
  const body = (await response.json()) as {
    notes?: Array<Record<string, unknown>>
  }
  return (body.notes ?? []).flatMap((note) => {
    if (typeof note.id !== "string" || typeof note.content !== "string") {
      return []
    }
    return [
      {
        id: note.id,
        content: note.content,
        createdAt: typeof note.created_at === "string" ? note.created_at : null,
        userName: referenceName(note.user),
      },
    ]
  })
}

export async function createPagerdutyWebhookSubscription(input: {
  accessToken: string
  region: PagerdutyRegion
  deliveryUrl: string
}): Promise<{ id: string; secret: string }> {
  const response = await pagerdutyFetch({
    region: input.region,
    accessToken: input.accessToken,
    path: "/webhook_subscriptions",
    method: "POST",
    json: {
      webhook_subscription: {
        type: "webhook_subscription",
        delivery_method: {
          type: "http_delivery_method",
          url: input.deliveryUrl,
        },
        description: "ctx| PagerDuty incident sync",
        events: [...PAGERDUTY_INCIDENT_WEBHOOK_EVENTS],
        filter: { type: "account_reference" },
      },
    },
  })
  if (!response.ok) {
    throw new Error(
      `PagerDuty webhook subscription create failed (${response.status})`,
    )
  }
  const body = (await response.json()) as {
    webhook_subscription?: {
      id?: string
      delivery_method?: { secret?: string }
    }
  }
  const id = body.webhook_subscription?.id
  const secret = body.webhook_subscription?.delivery_method?.secret
  if (!id || !secret) {
    throw new Error("PagerDuty webhook subscription did not return an id/secret")
  }
  return { id, secret }
}

export async function deletePagerdutyWebhookSubscription(input: {
  accessToken: string
  region: PagerdutyRegion
  subscriptionId: string
}): Promise<void> {
  const response = await pagerdutyFetch({
    region: input.region,
    accessToken: input.accessToken,
    path: `/webhook_subscriptions/${encodeURIComponent(input.subscriptionId)}`,
    method: "DELETE",
  })
  if (!response.ok && response.status !== 404) {
    throw new Error(
      `PagerDuty webhook subscription delete failed (${response.status})`,
    )
  }
}

/**
 * Keep the existing subscription when we still have its signing secret.
 * Otherwise replace only this connection's subscription. Never delete other
 * subscriptions on the shared Event URL — another org may own them.
 */
export async function ensurePagerdutyWebhookSubscription(input: {
  accessToken: string
  region: PagerdutyRegion
  deliveryUrl: string
  existingSubscriptionId: string | null
  hasStoredSecret: boolean
}): Promise<{ id: string; secret: string } | { id: string; reused: true }> {
  if (input.existingSubscriptionId && input.hasStoredSecret) {
    return { id: input.existingSubscriptionId, reused: true }
  }
  if (input.existingSubscriptionId) {
    try {
      await deletePagerdutyWebhookSubscription({
        accessToken: input.accessToken,
        region: input.region,
        subscriptionId: input.existingSubscriptionId,
      })
    } catch {
      // Best-effort replace; create still proceeds.
    }
  }
  return createPagerdutyWebhookSubscription({
    accessToken: input.accessToken,
    region: input.region,
    deliveryUrl: input.deliveryUrl,
  })
}
