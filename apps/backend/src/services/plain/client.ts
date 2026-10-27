import { z } from "zod"

import { assertNotInOrgDbContext } from "../../db/client.js"
import {
  PLAIN_REQUIRED_PERMISSIONS,
  plainIdSchema,
} from "../../domain/workspace-sources/providers/plain.js"
import { log } from "../../observability/logger.js"
import { readBoundedJson } from "../connectors/bounded-json.js"
import type {
  PlainArticleForMirror,
  PlainThreadForMirror,
} from "./converter.js"

/** The header that carries the webhook token of the connection. */
export const PLAIN_WEBHOOK_TOKEN_HEADER = "X-Ctxpipe-Webhook-Token"

/**
 * Plain refused the API key: it is not valid any more, or it lost a
 * permission. Plain says not to retry either, so the fix is a reconnect.
 */
export class PlainUnauthorizedError extends Error {
  constructor(message = "Plain refused the API key") {
    super(message)
    this.name = "PlainUnauthorizedError"
  }
}

const graphqlErrorsSchema = z
  .array(
    z.object({
      message: z.string(),
      extensions: z.object({ code: z.string().optional() }).nullish(),
    }),
  )
  .nullish()

/**
 * One GraphQL operation. On a rate limit, wait for `Retry-After` and send
 * the same request again, so the caller's sync still succeeds. An
 * `interactive` operation (an admin request) retries one time and waits at
 * most 5 seconds, so a person never waits for minutes.
 */
async function plainRequest<T extends z.ZodTypeAny>(
  apiKey: string,
  operation: {
    name: string
    query: string
    variables?: object
    interactive?: boolean
  },
  schema: T,
): Promise<z.infer<T>> {
  assertNotInOrgDbContext()
  const maxRetries = operation.interactive ? 1 : 4
  const maxWaitSeconds = operation.interactive ? 5 : 60
  for (let attempt = 0; ; attempt += 1) {
    const response = await fetch("https://core-api.uk.plain.com/graphql/v1", {
      signal: AbortSignal.timeout(30_000),
      // The API key must go only to this URL: a redirect is an error.
      redirect: "error",
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        operationName: operation.name,
        query: operation.query,
        variables: operation.variables ?? {},
      }),
    })
    if (response.status === 401) throw new PlainUnauthorizedError()
    if (response.status === 429 && attempt < maxRetries) {
      const retryAfter = Number(response.headers.get("retry-after"))
      const delayMs =
        Number.isFinite(retryAfter) && retryAfter > 0
          ? Math.min(retryAfter, maxWaitSeconds) * 1000
          : Math.min(1000 * 2 ** attempt, maxWaitSeconds * 1000)
      await new Promise((resolve) => setTimeout(resolve, delayMs))
      continue
    }
    if (!response.ok)
      throw new Error(`Plain ${operation.name} failed (${response.status})`)
    // A page of threads with their messages is far below 32 MiB.
    const body = (await readBoundedJson(response, 32 * 1024 * 1024)) as {
      data?: unknown
      errors?: unknown
    }
    const errors = graphqlErrorsSchema.parse(body.errors) ?? []
    if (
      errors.some((error) =>
        ["UNAUTHENTICATED", "FORBIDDEN"].includes(error.extensions?.code ?? ""),
      )
    )
      throw new PlainUnauthorizedError()
    if (errors.length)
      throw new Error(
        `Plain ${operation.name} failed: ${errors.map((error) => error.message).join("; ")}`,
      )
    return schema.parse(body.data)
  }
}

/** A time as ISO 8601: it goes into a heading, so no other text may pass. */
const iso = z
  .object({
    iso8601: z
      .string()
      .regex(
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/,
        "Use an ISO 8601 time",
      ),
  })
  .transform((value) => value.iso8601)

type Page<T> = {
  nodes: T[]
  pageInfo: { hasNextPage: boolean; endCursor: string | null }
}

/** A Relay connection, as its nodes and its page info. */
const connection = <T extends z.ZodTypeAny>(node: T) =>
  z
    .object({
      edges: z.array(z.object({ node })),
      pageInfo: z.object({
        hasNextPage: z.boolean(),
        endCursor: z.string().nullable(),
      }),
    })
    .transform(({ edges, pageInfo }): Page<z.infer<T>> => ({
      nodes: edges.map((edge) => (edge as { node: z.infer<T> }).node),
      pageInfo,
    }))

const LAST_PAGE = {
  nodes: [],
  pageInfo: { hasNextPage: false, endCursor: null },
}

/**
 * The nodes of a connection, page by page from a null cursor, up to
 * `limit` nodes or 50 pages. A cursor that comes back again is an error,
 * not a loop. At the page cap, the read logs and fails: a partial list
 * must not look like a complete one (a missing item is a delete).
 */
async function readPages<T>(
  readPage: (after: string | null) => Promise<Page<T>>,
  limit = Number.POSITIVE_INFINITY,
): Promise<T[]> {
  const maxPages = 50
  const nodes: T[] = []
  const seen = new Set<string>()
  let after: string | null = null
  let pages = 0
  do {
    if (pages === maxPages) {
      log.warn({
        step: "plain.read.page_cap",
        message: "Plain read hit the page cap",
        maxPages,
      })
      throw new Error(`Plain has more than ${maxPages} pages in one read`)
    }
    pages += 1
    const page: Page<T> = await readPage(after)
    nodes.push(...page.nodes)
    after = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null
    if (after !== null && seen.has(after))
      throw new Error("Plain gave the same page cursor two times")
    if (after !== null) seen.add(after)
  } while (after !== null && nodes.length < limit)
  return nodes.slice(0, limit)
}

/**
 * Check a pasted API key: give its workspace, or a message for the user
 * that names the permissions that the key does not have.
 */
export async function verifyPlainApiKey(
  apiKey: string,
): Promise<
  | { ok: true; workspace: { id: string; name: string } }
  | { ok: false; error: string }
> {
  let data: {
    myWorkspace: { id: string; name: string } | null
    myPermissions: { permissions: string[] }
  }
  try {
    data = await plainRequest(
      apiKey,
      {
        name: "PlainAccess",
        interactive: true,
        query:
          "query PlainAccess { myWorkspace { id name } myPermissions { permissions } }",
      },
      z.object({
        myWorkspace: z.object({ id: z.string(), name: z.string() }).nullable(),
        myPermissions: z.object({ permissions: z.array(z.string()) }),
      }),
    )
  } catch (error) {
    if (error instanceof PlainUnauthorizedError)
      return { ok: false, error: "Plain does not accept this API key" }
    throw error
  }
  if (!data.myWorkspace)
    return { ok: false, error: "The Plain API key has no workspace" }
  const missing = PLAIN_REQUIRED_PERMISSIONS.filter(
    (permission) => !data.myPermissions.permissions.includes(permission),
  )
  if (missing.length)
    return {
      ok: false,
      error: `The Plain API key does not have these permissions: ${missing.join(", ")}`,
    }
  return { ok: true, workspace: data.myWorkspace }
}

/** The Help Centers of the workspace, for the scope picker. */
export async function listPlainHelpCenters(
  apiKey: string,
): Promise<Array<{ id: string; name: string }>> {
  const node = z.object({
    id: z.string(),
    internalName: z.string(),
    isDeleted: z.boolean(),
  })
  const centers = await readPages(
    async (after) =>
      (
        await plainRequest(
          apiKey,
          {
            name: "PlainHelpCenters",
            interactive: true,
            query: `query PlainHelpCenters($after: String) {
              helpCenters(first: 100, after: $after) {
                edges { node { id internalName isDeleted } }
                pageInfo { hasNextPage endCursor }
              }
            }`,
            variables: { after },
          },
          z.object({ helpCenters: connection(node) }),
        )
      ).helpCenters,
  )
  return centers
    .filter((center) => !center.isDeleted)
    .map((center) => ({ id: center.id, name: center.internalName }))
}

/** The label types that are not archived, for the scope picker. */
export async function listPlainLabelTypes(
  apiKey: string,
): Promise<Array<{ id: string; name: string }>> {
  return readPages(
    async (after) =>
      (
        await plainRequest(
          apiKey,
          {
            name: "PlainLabelTypes",
            interactive: true,
            query: `query PlainLabelTypes($after: String) {
              labelTypes(filters: { isArchived: false }, first: 100, after: $after) {
                edges { node { id name } }
                pageInfo { hasNextPage endCursor }
              }
            }`,
            variables: { after },
          },
          z.object({
            labelTypes: connection(
              z.object({ id: z.string(), name: z.string() }),
            ),
          }),
        )
      ).labelTypes,
  )
}

const articleNode = z.object({
  // The id is a path segment of the file (ADR-059).
  id: plainIdSchema,
  title: z.string(),
  slug: z.string(),
  contentHtml: z.string(),
  status: z.string(),
  createdAt: iso,
  updatedAt: iso,
  articleGroup: z.object({ name: z.string() }).nullable(),
})

/** The published articles of a Help Center, or `not_found`. */
export async function listPlainHelpCenterArticles(input: {
  apiKey: string
  helpCenterId: string
}): Promise<PlainArticleForMirror[] | "not_found"> {
  let missing = false
  const articles = await readPages(async (after) => {
    const data = await plainRequest(
      input.apiKey,
      {
        name: "PlainHelpCenterArticles",
        query: `query PlainHelpCenterArticles($helpCenterId: ID!, $after: String) {
          helpCenter(id: $helpCenterId) {
            isDeleted
            articles(first: 100, after: $after) {
              edges { node { id title slug contentHtml status createdAt { iso8601 } updatedAt { iso8601 } articleGroup { name } } }
              pageInfo { hasNextPage endCursor }
            }
          }
        }`,
        variables: { helpCenterId: input.helpCenterId, after },
      },
      z.object({
        helpCenter: z
          .object({ isDeleted: z.boolean(), articles: connection(articleNode) })
          .nullable(),
      }),
    )
    if (!data.helpCenter || data.helpCenter.isDeleted) {
      missing = true
      return LAST_PAGE
    }
    return data.helpCenter.articles
  })
  if (missing) return "not_found"
  return articles
    .filter((article) => article.status === "PUBLISHED")
    .map((article) => ({
      id: article.id,
      title: article.title,
      slug: article.slug,
      contentHtml: article.contentHtml,
      groupName: article.articleGroup?.name ?? null,
      createdAt: article.createdAt,
      updatedAt: article.updatedAt,
    }))
}

/** The name of a timeline actor, without an email address. */
const actorSchema = z
  .object({
    __typename: z.string(),
    user: z.object({ fullName: z.string() }).optional(),
    customer: z.object({ fullName: z.string() }).optional(),
    machineUser: z.object({ publicName: z.string() }).optional(),
  })
  .transform(
    (actor) =>
      actor.user?.fullName ??
      actor.customer?.fullName ??
      actor.machineUser?.publicName ??
      null,
  )

const threadNode = z.object({
  // The id is a path segment of the file (ADR-059).
  id: plainIdSchema,
  // The ref and the status go into headings: a short token, no other text.
  ref: z.string().regex(/^[A-Za-z0-9_-]{1,32}$/, "Use a Plain thread ref"),
  title: z.string(),
  status: z.string().regex(/^[A-Za-z_]{1,32}$/, "Use a Plain thread status"),
  priority: z.number(),
  createdAt: iso,
  updatedAt: iso,
  customer: z.object({ fullName: z.string() }).nullable(),
  labels: z.array(z.object({ labelType: z.object({ name: z.string() }) })),
  timelineEntries: connection(
    z.object({
      timestamp: iso,
      llmText: z.string().nullable(),
      entry: z.object({ __typename: z.string() }),
      actor: actorSchema,
    }),
  ),
})

/**
 * The newest 100 threads of a label (spam excluded), or `not_found` when
 * the label does not exist or is archived. One request reads 25 threads
 * with the first 50 messages and notes of each, so a label costs at most
 * four requests. A longer thread is marked, not read further.
 */
export async function listPlainLabelThreads(input: {
  apiKey: string
  labelTypeId: string
}): Promise<PlainThreadForMirror[] | "not_found"> {
  let missing = false
  const threads = await readPages(async (after) => {
    const data = await plainRequest(
      input.apiKey,
      {
        name: "PlainLabelThreads",
        query: `query PlainLabelThreads($labelTypeId: ID!, $after: String) {
          labelType(labelTypeId: $labelTypeId) { isArchived }
          threads(
            filters: { labelTypeIds: [$labelTypeId], isMarkedAsSpam: false }
            sortBy: { field: CREATED_AT, direction: DESC }
            first: 25
            after: $after
          ) {
            edges { node {
              id ref title status priority createdAt { iso8601 } updatedAt { iso8601 }
              customer { fullName }
              labels { labelType { name } }
              timelineEntries(filters: { entryTypes: [EMAIL, CHAT, NOTE, SLACK_MESSAGE, SLACK_REPLY, MS_TEAMS_MESSAGE, DISCORD_MESSAGE, MERGED_THREAD_MESSAGE] }, first: 50) {
                edges { node {
                  timestamp { iso8601 }
                  llmText
                  entry { __typename }
                  actor {
                    __typename
                    ... on UserActor { user { fullName } }
                    ... on CustomerActor { customer { fullName } }
                    ... on MachineUserActor { machineUser { publicName } }
                  }
                } }
                pageInfo { hasNextPage endCursor }
              }
            } }
            pageInfo { hasNextPage endCursor }
          }
        }`,
        variables: { labelTypeId: input.labelTypeId, after },
      },
      z.object({
        labelType: z.object({ isArchived: z.boolean() }).nullable(),
        threads: connection(threadNode),
      }),
    )
    if (!data.labelType || data.labelType.isArchived) {
      missing = true
      return LAST_PAGE
    }
    return data.threads
  }, 100)
  if (missing) return "not_found"
  return threads.map((thread) => ({
    id: thread.id,
    ref: thread.ref,
    title: thread.title,
    status: thread.status,
    priority: thread.priority,
    customerName: thread.customer?.fullName ?? null,
    labels: thread.labels.map((label) => label.labelType.name),
    createdAt: thread.createdAt,
    updatedAt: thread.updatedAt,
    messages: thread.timelineEntries.nodes.flatMap((entry) =>
      entry.llmText?.trim()
        ? [
            {
              authorName: entry.actor,
              createdAt: entry.timestamp,
              internal: entry.entry.__typename === "NoteEntry",
              text: entry.llmText,
            },
          ]
        : [],
    ),
    moreMessages: thread.timelineEntries.pageInfo.hasNextPage,
  }))
}

const mutationErrorSchema = z.object({ message: z.string() }).nullable()

/**
 * Create the webhook target of a connection: timeline events (each new
 * message, note, or label change of a thread) go to `url` with `token` in
 * a header that only the API can read back as a name.
 */
export async function createPlainWebhookTarget(input: {
  apiKey: string
  url: string
  token: string
}): Promise<string> {
  const data = await plainRequest(
    input.apiKey,
    {
      name: "PlainCreateWebhookTarget",
      interactive: true,
      query: `mutation PlainCreateWebhookTarget($input: CreateWebhookTargetInput!) {
        createWebhookTarget(input: $input) { webhookTarget { id } error { message } }
      }`,
      variables: {
        input: {
          url: input.url,
          description: "ctxpipe Workspace sources",
          isEnabled: true,
          version: "2026-10-06",
          eventSubscriptions: [
            { eventType: "timeline.timeline_entry_changed" },
          ],
          headers: [{ name: PLAIN_WEBHOOK_TOKEN_HEADER, value: input.token }],
        },
      },
    },
    z.object({
      createWebhookTarget: z.object({
        webhookTarget: z.object({ id: z.string() }).nullable(),
        error: mutationErrorSchema,
      }),
    }),
  )
  const created = data.createWebhookTarget
  if (!created.webhookTarget)
    throw new Error(
      `Plain refused the webhook target: ${created.error?.message ?? "no reason given"}`,
    )
  return created.webhookTarget.id
}

export async function deletePlainWebhookTarget(input: {
  apiKey: string
  webhookTargetId: string
}): Promise<void> {
  const data = await plainRequest(
    input.apiKey,
    {
      name: "PlainDeleteWebhookTarget",
      interactive: true,
      query: `mutation PlainDeleteWebhookTarget($webhookTargetId: ID!) {
        deleteWebhookTarget(input: { webhookTargetId: $webhookTargetId }) { error { message } }
      }`,
      variables: { webhookTargetId: input.webhookTargetId },
    },
    z.object({
      deleteWebhookTarget: z.object({ error: mutationErrorSchema }),
    }),
  )
  if (data.deleteWebhookTarget.error)
    throw new Error(
      `Plain did not delete the webhook target: ${data.deleteWebhookTarget.error.message}`,
    )
}
