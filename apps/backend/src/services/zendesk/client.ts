import { z } from "zod"

import { assertNotInOrgDbContext } from "../../db/client.js"
import { readBoundedJson } from "../connectors/bounded-json.js"
import {
  isZendeskId,
  type ZendeskArticleForMirror,
  type ZendeskTicketForMirror,
} from "./converter.js"
import { ZendeskAuthorizationRevokedError } from "./oauth.js"

/** A source keeps this many of the most recently updated tickets of a view. */
const ZENDESK_TICKETS_PER_VIEW = 100

/**
 * The most bytes of one Zendesk answer. A page of 100 tickets or 100
 * comments is far below it.
 */
const ZENDESK_MAX_RESPONSE_BYTES = 32 * 1024 * 1024

const readJson = (response: Response) =>
  readBoundedJson(response, ZENDESK_MAX_RESPONSE_BYTES)

type ZendeskAuth = { subdomain: string; accessToken: string }

const origin = (subdomain: string) => `https://${subdomain}.zendesk.com`

/**
 * One request. On a rate limit, wait for `Retry-After` and send the same
 * request again, so the caller's sync still succeeds.
 */
async function zendeskRequest(
  auth: ZendeskAuth,
  url: URL,
  init: { method?: string; json?: unknown } = {},
): Promise<Response> {
  assertNotInOrgDbContext()
  for (let attempt = 0; ; attempt += 1) {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(30_000),
      // A redirect must not take the access token to another host.
      redirect: "error",
      method: init.method ?? "GET",
      headers: {
        accept: "application/json",
        authorization: `Bearer ${auth.accessToken}`,
        ...(init.json ? { "content-type": "application/json" } : {}),
      },
      body: init.json ? JSON.stringify(init.json) : undefined,
    })
    if (response.status === 401) throw new ZendeskAuthorizationRevokedError()
    if (response.status !== 429 || attempt >= 4) return response
    const retryAfter = Number(response.headers.get("retry-after"))
    const delayMs =
      Number.isFinite(retryAfter) && retryAfter > 0
        ? Math.min(retryAfter, 60) * 1000
        : 1000 * 2 ** attempt
    await new Promise((resolve) => setTimeout(resolve, delayMs))
  }
}

const apiUrl = (
  auth: ZendeskAuth,
  path: string,
  search: Record<string, string> = {},
) => {
  const url = new URL(`${origin(auth.subdomain)}/api/v2${path}`)
  for (const [name, value] of Object.entries(search))
    url.searchParams.set(name, value)
  return url
}

const pageSchema = z.object({
  meta: z.object({ has_more: z.boolean() }).nullish(),
  links: z.object({ next: z.string().nullish() }).nullish(),
})

/**
 * Every page of a list, from its first URL. A next page on another host is
 * an error: the access token must go only to the subdomain of the account.
 * Gives `not_found` (404) or `forbidden` (403) for the first page.
 */
async function readPages<T extends z.ZodTypeAny>(
  auth: ZendeskAuth,
  first: URL,
  schema: T,
  what: string,
): Promise<Array<z.infer<T>> | "not_found" | "forbidden"> {
  const pages: Array<z.infer<T>> = []
  let url: URL | null = first
  while (url) {
    const response = await zendeskRequest(auth, url)
    if (!pages.length && response.status === 404) return "not_found"
    if (!pages.length && response.status === 403) return "forbidden"
    if (!response.ok)
      throw new Error(`Zendesk ${what} failed (${response.status})`)
    const body: unknown = await readJson(response)
    pages.push(schema.parse(body))
    const page = pageSchema.parse(body)
    const next = page.meta?.has_more ? page.links?.next : null
    url = next ? new URL(next) : null
    if (url && url.origin !== origin(auth.subdomain))
      throw new Error(`Zendesk ${what} gave a next page on another host`)
  }
  return pages
}

const id = z.union([z.number(), z.string()]).transform(String)
const nullableString = z.string().nullish().default(null)
const named = z.object({ id, name: z.string() })
const nameById = (items: Array<{ id: string; name: string }>) =>
  new Map(items.map((item) => [item.id, item.name]))

/** The Help Center categories of the account, for the scope picker. */
export async function listZendeskCategories(
  auth: ZendeskAuth,
): Promise<Array<{ id: string; name: string }>> {
  const pages = await readPages(
    auth,
    apiUrl(auth, "/help_center/categories", { "page[size]": "100" }),
    z.object({ categories: z.array(named) }),
    "category list",
  )
  if (typeof pages === "string")
    throw new Error(`Zendesk category list failed (${pages})`)
  return pages.flatMap((page) => page.categories)
}

/** The active ticket views that the user can read, for the scope picker. */
export async function listZendeskViews(
  auth: ZendeskAuth,
): Promise<Array<{ id: string; title: string }>> {
  const pages = await readPages(
    auth,
    apiUrl(auth, "/views", { "page[size]": "100" }),
    z.object({
      views: z.array(z.object({ id, title: z.string(), active: z.boolean() })),
    }),
    "view list",
  )
  if (typeof pages === "string")
    throw new Error(`Zendesk view list failed (${pages})`)
  return pages
    .flatMap((page) => page.views)
    .filter((view) => view.active)
    .map(({ id, title }) => ({ id, title }))
}

const articlePageSchema = z.object({
  articles: z.array(
    z.object({
      id,
      title: z.string(),
      body: nullableString,
      html_url: z.string(),
      section_id: id.nullish().default(null),
      author_id: id.nullish().default(null),
      draft: z.boolean().nullish(),
      locale: nullableString,
      label_names: z.array(z.string()).nullish(),
      created_at: nullableString,
      updated_at: nullableString,
    }),
  ),
  users: z.array(named).nullish(),
  sections: z.array(named).nullish(),
})

/**
 * The published articles of one category, with section and author names
 * sideloaded on each page: one request for each page of 100 articles.
 */
export async function listZendeskCategoryArticles(
  input: ZendeskAuth & { categoryId: string },
): Promise<ZendeskArticleForMirror[] | "not_found" | "forbidden"> {
  const pages = await readPages(
    input,
    apiUrl(input, `/help_center/categories/${input.categoryId}/articles`, {
      include: "users,sections",
      "page[size]": "100",
    }),
    articlePageSchema,
    "article list",
  )
  if (typeof pages === "string") return pages
  return pages.flatMap((page) => {
    const users = nameById(page.users ?? [])
    const sections = nameById(page.sections ?? [])
    return page.articles
      .filter((article) => !article.draft)
      .map((article) => ({
        id: article.id,
        title: article.title,
        url: article.html_url,
        bodyHtml: article.body ?? "",
        sectionId: article.section_id,
        sectionName: article.section_id
          ? (sections.get(article.section_id) ?? null)
          : null,
        locale: article.locale,
        labels: article.label_names ?? [],
        authorName: article.author_id
          ? (users.get(article.author_id) ?? null)
          : null,
        createdAt: article.created_at,
        updatedAt: article.updated_at,
      }))
  })
}

const ticketSchema = z.object({
  id,
  subject: z.string().nullish(),
  status: z.string(),
  priority: nullableString,
  type: nullableString,
  tags: z.array(z.string()).nullish(),
  requester_id: id.nullish().default(null),
  assignee_id: id.nullish().default(null),
  created_at: nullableString,
  updated_at: nullableString,
})

// Only the fields that the mirror renders. Zod drops the rest, so user
// emails and attachment URLs never reach a file.
const commentPageSchema = z.object({
  comments: z.array(
    z.object({
      author_id: id.nullish().default(null),
      plain_body: z.string().nullish(),
      public: z.boolean(),
      created_at: nullableString,
      attachments: z
        .array(z.object({ file_name: z.string() }))
        .nullish()
        .default([]),
    }),
  ),
  users: z.array(named).nullish(),
})

/**
 * The most recently updated tickets of one view, with their comments.
 * Zendesk has no bulk comment read for a list of tickets, so each ticket
 * is one more request (the count is capped by ZENDESK_TICKETS_PER_VIEW).
 */
export async function listZendeskViewTickets(
  input: ZendeskAuth & { viewId: string },
): Promise<ZendeskTicketForMirror[] | "not_found" | "forbidden"> {
  const response = await zendeskRequest(
    input,
    apiUrl(input, `/views/${input.viewId}/tickets`, {
      sort_by: "updated",
      sort_order: "desc",
      per_page: String(ZENDESK_TICKETS_PER_VIEW),
    }),
  )
  if (response.status === 404) return "not_found"
  if (response.status === 403) return "forbidden"
  if (!response.ok)
    throw new Error(`Zendesk view tickets failed (${response.status})`)
  const { tickets } = z
    .object({ tickets: z.array(ticketSchema) })
    .parse(await readJson(response))
  const result: ZendeskTicketForMirror[] = []
  for (const ticket of tickets) {
    // The id goes into the request path, so only a numeric id is read.
    if (!isZendeskId(ticket.id)) continue
    const pages = await readPages(
      input,
      apiUrl(input, `/tickets/${ticket.id}/comments`, {
        include: "users",
        "page[size]": "100",
      }),
      commentPageSchema,
      "comment list",
    )
    // A ticket deleted since the view read has no comments to show.
    if (typeof pages === "string") continue
    // The comment sideload names the requester and the assignee when they
    // wrote a comment; Zendesk has no other bulk read of people.
    const users = nameById(pages.flatMap((page) => page.users ?? []))
    result.push({
      id: ticket.id,
      subject: ticket.subject?.trim() || "(no subject)",
      url: `${origin(input.subdomain)}/agent/tickets/${ticket.id}`,
      status: ticket.status,
      priority: ticket.priority,
      type: ticket.type,
      tags: ticket.tags ?? [],
      requesterName: ticket.requester_id
        ? (users.get(ticket.requester_id) ?? null)
        : null,
      assigneeName: ticket.assignee_id
        ? (users.get(ticket.assignee_id) ?? null)
        : null,
      createdAt: ticket.created_at,
      updatedAt: ticket.updated_at,
      comments: pages.flatMap((page) => {
        return page.comments.map((comment) => ({
          authorName: comment.author_id
            ? (users.get(comment.author_id) ?? null)
            : null,
          createdAt: comment.created_at,
          public: comment.public,
          body: comment.plain_body ?? "",
          attachments: (comment.attachments ?? []).map(
            (attachment) => attachment.file_name,
          ),
        }))
      }),
    })
  }
  return result
}

/**
 * Create the one webhook of a connection for Help Center article events,
 * and read its signing secret. Zendesk sends ticket events only through a
 * trigger, so tickets do not use it (ADR-058).
 */
export async function createZendeskArticleWebhook(
  input: ZendeskAuth & { endpoint: string },
): Promise<{ webhookId: string; signingSecret: string }> {
  const created = await zendeskRequest(input, apiUrl(input, "/webhooks"), {
    method: "POST",
    json: {
      webhook: {
        name: "ctxpipe Help Center sync",
        endpoint: input.endpoint,
        http_method: "POST",
        request_format: "json",
        status: "active",
        subscriptions: [
          "zen:event-type:article.published",
          "zen:event-type:article.unpublished",
        ],
      },
    },
  })
  if (!created.ok)
    throw new Error(`Zendesk webhook create failed (${created.status})`)
  const { webhook } = z
    .object({ webhook: z.object({ id }) })
    .parse(await readJson(created))
  // The id goes into the request path. Zendesk webhook ids are letters and
  // digits (not numbers like the other ids).
  if (!/^[A-Za-z0-9]{1,64}$/.test(webhook.id))
    throw new Error("Zendesk gave a webhook id that is not valid")
  const secret = await zendeskRequest(
    input,
    apiUrl(input, `/webhooks/${webhook.id}/signing_secret`),
  )
  if (!secret.ok)
    throw new Error(`Zendesk webhook secret read failed (${secret.status})`)
  const { signing_secret } = z
    .object({ signing_secret: z.object({ secret: z.string().min(1) }) })
    .parse(await readJson(secret))
  return { webhookId: webhook.id, signingSecret: signing_secret.secret }
}

/** Delete the webhook of a connection. A webhook that is gone is a success. */
export async function deleteZendeskWebhook(
  input: ZendeskAuth & { webhookId: string },
): Promise<void> {
  const response = await zendeskRequest(
    input,
    apiUrl(input, `/webhooks/${encodeURIComponent(input.webhookId)}`),
    { method: "DELETE" },
  )
  if (!response.ok && response.status !== 404)
    throw new Error(`Zendesk webhook delete failed (${response.status})`)
}

/**
 * Revoke the access token at Zendesk, so that a copy of it stops working
 * after the connection is removed. A token that is already invalid is a
 * success.
 */
export async function revokeZendeskAccessToken(
  auth: ZendeskAuth,
): Promise<void> {
  let response: Response
  try {
    response = await zendeskRequest(
      auth,
      apiUrl(auth, "/oauth/tokens/current"),
      {
        method: "DELETE",
      },
    )
  } catch (caught) {
    if (caught instanceof ZendeskAuthorizationRevokedError) return
    throw caught
  }
  if (!response.ok && response.status !== 404)
    throw new Error(`Zendesk token revoke failed (${response.status})`)
}
