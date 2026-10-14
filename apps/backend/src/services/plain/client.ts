import { z } from "zod"
import { assertNotInOrgDbContext } from "../../db/client.js"
import type {
  PlainArticleForMirror,
  PlainThreadForMirror,
} from "./converter.js"

const PLAIN_API_URL = "https://core-api.uk.plain.com/graphql/v1"

/** A source keeps this many of the newest threads of a label. */
export const PLAIN_THREADS_PER_LABEL = 100

/**
 * The permissions of the machine-user API key (ADR-055): read the content,
 * and create and delete the one webhook target of the connection.
 */
export const PLAIN_REQUIRED_PERMISSIONS = [
  "helpCenter:read",
  "labelType:read",
  "thread:read",
  "timeline:read",
  "customer:read",
  "user:read",
  "webhookTarget:create",
  "webhookTarget:delete",
]

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
 * the same request again, so the caller's sync still succeeds.
 */
async function plainRequest<T extends z.ZodTypeAny>(
  apiKey: string,
  operation: { name: string; query: string; variables?: object },
  schema: T,
): Promise<z.infer<T>> {
  assertNotInOrgDbContext()
  for (let attempt = 0; ; attempt += 1) {
    const response = await fetch(PLAIN_API_URL, {
      signal: AbortSignal.timeout(30_000),
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
    if (response.status === 429 && attempt < 4) {
      const retryAfter = Number(response.headers.get("retry-after"))
      const delayMs =
        Number.isFinite(retryAfter) && retryAfter > 0
          ? Math.min(retryAfter, 60) * 1000
          : 1000 * 2 ** attempt
      await new Promise((resolve) => setTimeout(resolve, delayMs))
      continue
    }
    if (!response.ok)
      throw new Error(`Plain ${operation.name} failed (${response.status})`)
    const body = (await response.json()) as { data?: unknown; errors?: unknown }
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

const iso = z
  .object({ iso8601: z.string() })
  .transform((value) => value.iso8601)
const pageInfo = z.object({
  hasNextPage: z.boolean(),
  endCursor: z.string().nullable(),
})
const connection = <T extends z.ZodTypeAny>(node: T) =>
  z.object({ edges: z.array(z.object({ node })), pageInfo })

/** Every node of a connection, page by page from a null cursor. */
async function readPages<T>(
  readPage: (after: string | null) => Promise<{
    nodes: T[]
    pageInfo: { hasNextPage: boolean; endCursor: string | null }
  }>,
): Promise<T[]> {
  const nodes: T[] = []
  let after: string | null = null
  do {
    const page = await readPage(after)
    nodes.push(...page.nodes)
    after = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null
  } while (after)
  return nodes
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
  const centers = await readPages(async (after) => {
    const data = await plainRequest(
      apiKey,
      {
        name: "PlainHelpCenters",
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
    return {
      nodes: data.helpCenters.edges.map((edge) => edge.node),
      pageInfo: data.helpCenters.pageInfo,
    }
  })
  return centers
    .filter((center) => !center.isDeleted)
    .map((center) => ({ id: center.id, name: center.internalName }))
}

/** The label types that are not archived, for the scope picker. */
export async function listPlainLabelTypes(
  apiKey: string,
): Promise<Array<{ id: string; name: string }>> {
  return readPages(async (after) => {
    const data = await plainRequest(
      apiKey,
      {
        name: "PlainLabelTypes",
        query: `query PlainLabelTypes($after: String) {
          labelTypes(filters: { isArchived: false }, first: 100, after: $after) {
            edges { node { id name } }
            pageInfo { hasNextPage endCursor }
          }
        }`,
        variables: { after },
      },
      z.object({
        labelTypes: connection(z.object({ id: z.string(), name: z.string() })),
      }),
    )
    return {
      nodes: data.labelTypes.edges.map((edge) => edge.node),
      pageInfo: data.labelTypes.pageInfo,
    }
  })
}

const articleNode = z.object({
  id: z.string(),
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
      return { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } }
    }
    return {
      nodes: data.helpCenter.articles.edges.map((edge) => edge.node),
      pageInfo: data.helpCenter.articles.pageInfo,
    }
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

const threadNode = z.object({
  id: z.string(),
  ref: z.string(),
  title: z.string(),
  status: z.string(),
  priority: z.number(),
  createdAt: iso,
  updatedAt: iso,
  customer: z.object({ fullName: z.string() }).nullable(),
  labels: z.array(z.object({ labelType: z.object({ name: z.string() }) })),
})

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

const messageNode = z.object({
  timestamp: iso,
  llmText: z.string().nullable(),
  entry: z.object({ __typename: z.string() }),
  actor: actorSchema,
})

/** The messages and notes of one thread, oldest first. */
async function listThreadMessages(
  apiKey: string,
  threadId: string,
): Promise<PlainThreadForMirror["messages"]> {
  const entries = await readPages(async (after) => {
    const data = await plainRequest(
      apiKey,
      {
        name: "PlainThreadMessages",
        query: `query PlainThreadMessages($threadId: ID!, $after: String) {
          thread(threadId: $threadId) {
            timelineEntries(filters: { entryTypes: [EMAIL, CHAT, NOTE, SLACK_MESSAGE, SLACK_REPLY, MS_TEAMS_MESSAGE, DISCORD_MESSAGE] }, first: 100, after: $after) {
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
          }
        }`,
        variables: { threadId, after },
      },
      z.object({
        thread: z
          .object({ timelineEntries: connection(messageNode) })
          .nullable(),
      }),
    )
    return data.thread
      ? {
          nodes: data.thread.timelineEntries.edges.map((edge) => edge.node),
          pageInfo: data.thread.timelineEntries.pageInfo,
        }
      : { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } }
  })
  return entries.flatMap((entry) =>
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
  )
}

/**
 * The newest threads of a label (spam excluded), each with its messages
 * and notes, or `not_found` when the label does not exist.
 */
export async function listPlainLabelThreads(input: {
  apiKey: string
  labelTypeId: string
}): Promise<PlainThreadForMirror[] | "not_found"> {
  const data = await plainRequest(
    input.apiKey,
    {
      name: "PlainLabelThreads",
      query: `query PlainLabelThreads($labelTypeId: ID!, $first: Int!) {
        labelType(labelTypeId: $labelTypeId) { id }
        threads(
          filters: { labelTypeIds: [$labelTypeId], isMarkedAsSpam: false }
          sortBy: { field: CREATED_AT, direction: DESC }
          first: $first
        ) {
          edges { node { id ref title status priority createdAt { iso8601 } updatedAt { iso8601 } customer { fullName } labels { labelType { name } } } }
          pageInfo { hasNextPage endCursor }
        }
      }`,
      variables: {
        labelTypeId: input.labelTypeId,
        first: PLAIN_THREADS_PER_LABEL,
      },
    },
    z.object({
      labelType: z.object({ id: z.string() }).nullable(),
      threads: connection(threadNode),
    }),
  )
  if (!data.labelType) return "not_found"
  const threads: PlainThreadForMirror[] = []
  for (const { node } of data.threads.edges)
    threads.push({
      id: node.id,
      ref: node.ref,
      title: node.title,
      status: node.status,
      priority: node.priority,
      customerName: node.customer?.fullName ?? null,
      labels: node.labels.map((label) => label.labelType.name),
      createdAt: node.createdAt,
      updatedAt: node.updatedAt,
      messages: await listThreadMessages(input.apiKey, node.id),
    })
  return threads
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
      query: `mutation PlainCreateWebhookTarget($input: CreateWebhookTargetInput!) {
        createWebhookTarget(input: $input) { webhookTarget { id } error { message } }
      }`,
      variables: {
        input: {
          url: input.url,
          description: "ctx| Workspace sources",
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
