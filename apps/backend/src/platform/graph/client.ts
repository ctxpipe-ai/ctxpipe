import { AsyncLocalStorage } from "node:async_hooks"
import neo4j, { type Driver } from "neo4j-driver"
import { FalkorDB } from "falkordb"

const DB_PER_TENANT = ["falkordb", "neo4j-enterprise", "memgraph"] as const
type Provider = (typeof DB_PER_TENANT)[number] | "neo4j-community" | "neptune"

const DEFAULT_GRAPH_DB_URI = "redis://falkordb:6379"

export type GraphClient = {
  executeQuery(
    query: string,
    params?: Record<string, unknown>,
  ): Promise<{ records: Array<{ get: (key: string) => unknown }> }>
  close(): Promise<void>
}

export function getConfig(): {
  uri: string
  user: string
  password: string
  tenancy: "database-per-tenant" | "instance-per-tenant"
  provider: Provider
} {
  const uri = process.env.GRAPH_DB_URI ?? DEFAULT_GRAPH_DB_URI
  const provider = (process.env.GRAPH_DB_PROVIDER ?? "falkordb") as Provider
  const tenancy = DB_PER_TENANT.includes(
    provider as (typeof DB_PER_TENANT)[number],
  )
    ? "database-per-tenant"
    : "instance-per-tenant"
  return {
    uri,
    user:
      process.env.GRAPH_DB_USER ??
      (provider === "falkordb" ? "default" : "neo4j"),
    password: process.env.GRAPH_DB_PASSWORD ?? "",
    tenancy,
    provider,
  }
}

/** FalkorDB Graph.query returns { data: Array<Record<string, unknown>> } - rows are already objects. */
function falkorReplyToRecords(
  data: Array<Record<string, unknown>> | undefined,
): Array<{ get: (key: string) => unknown }> {
  if (!data) return []
  return data.map((row) => ({
    get: (k: string) => row[k],
  }))
}

type FalkorDBInstance = Awaited<ReturnType<typeof FalkorDB.connect>>

const LIMIT_OR_SKIP_PARAM_REGEX = /\b(?:LIMIT|SKIP)\s+\$([A-Za-z_][A-Za-z0-9_]*)\b/g

function normalizeBoltParamsForProvider(
  query: string,
  params: Record<string, unknown> | undefined,
  provider: Provider,
): Record<string, unknown> | undefined {
  if (!params || provider !== "neptune") return params

  const limitOrSkipParamNames = new Set<string>()
  for (const match of query.matchAll(LIMIT_OR_SKIP_PARAM_REGEX)) {
    if (match[1]) limitOrSkipParamNames.add(match[1])
  }
  if (limitOrSkipParamNames.size === 0) return params

  const next = { ...params }
  for (const name of limitOrSkipParamNames) {
    const value = next[name]
    if (typeof value !== "number") continue
    if (!Number.isInteger(value)) {
      throw new Error(
        `Neptune requires integer ${name} for LIMIT/SKIP; got non-integer number.`,
      )
    }
    next[name] = neo4j.int(value)
  }
  return next
}

function createFalkorDbGraphClient(
  db: FalkorDBInstance,
  orgId: string,
): GraphClient {
  return {
    async executeQuery(query, params) {
      const graph = db.selectGraph(orgId)
      const serialized = params
        ? Object.fromEntries(
            Object.entries(params).map(([k, v]) => [
              k,
              v instanceof Date ? v.toISOString() : v,
            ]),
          )
        : undefined
      type QueryOpts = Parameters<
        ReturnType<FalkorDBInstance["selectGraph"]>["query"]
      >[1]
      const reply = await graph.query(
        query,
        (serialized ? { params: serialized } : undefined) as QueryOpts,
      )
      const records = falkorReplyToRecords(
        reply.data as Array<Record<string, unknown>>,
      )
      return { records }
    },
    async close() {
      // No-op: shared db is closed in closeGraphDb
    },
  }
}

function scopedBoltDriver(
  inner: Driver,
  provider: Provider,
  database?: string,
): GraphClient {
  return {
    async executeQuery(query, params) {
      const normalizedParams = normalizeBoltParamsForProvider(
        query,
        params,
        provider,
      )
      const result = database
        ? await inner.executeQuery(query, normalizedParams, { database })
        : await inner.executeQuery(query, normalizedParams)
      return { records: result.records }
    },
    async close() {
      // No-op: shared driver is closed in closeGraphDb
    },
  }
}

let databasePerTenantBoltClient: Driver | null = null
let databasePerTenantFalkorDb: FalkorDBInstance | null = null
const instancePerTenantBoltClients = new Map<string, Driver>()

async function resolveFalkorDbClient(orgId: string): Promise<GraphClient> {
  const cfg = getConfig()
  const uri = cfg.uri
  if (!databasePerTenantFalkorDb) {
    databasePerTenantFalkorDb = await FalkorDB.connect({
      url: uri,
      username: cfg.user || undefined,
      password: cfg.password || undefined,
    })
  }
  return createFalkorDbGraphClient(databasePerTenantFalkorDb, orgId)
}

async function resolveBoltClient(
  orgId: string,
  orgSlug: string,
): Promise<GraphClient> {
  const cfg = getConfig()
  const auth = neo4j.auth.basic(cfg.user, cfg.password)
  if (cfg.tenancy === "database-per-tenant") {
    if (!databasePerTenantBoltClient) {
      databasePerTenantBoltClient = neo4j.driver(cfg.uri, auth)
    }
    return scopedBoltDriver(databasePerTenantBoltClient, cfg.provider, orgId)
  }
  const orgUri = process.env[`GRAPH_DB_URI_${orgSlug}`]
  if (!orgUri) {
    throw new Error(`GRAPH_DB_URI_${orgSlug} required for instance-per-tenant.`)
  }
  let driver = instancePerTenantBoltClients.get(orgSlug)
  if (!driver) {
    driver = neo4j.driver(orgUri, auth)
    instancePerTenantBoltClients.set(orgSlug, driver)
  }
  return scopedBoltDriver(driver, cfg.provider)
}

async function resolveClient(
  orgId: string,
  orgSlug: string,
): Promise<GraphClient> {
  const cfg = getConfig()
  if (cfg.provider === "falkordb") {
    return resolveFalkorDbClient(orgId)
  }
  return resolveBoltClient(orgId, orgSlug)
}

const storage = new AsyncLocalStorage<GraphClient>()

export async function withGraphClient<T>(
  { orgId, orgSlug }: { orgId: string; orgSlug: string },
  handler: () => Promise<T>,
): Promise<T> {
  const client = await resolveClient(orgId, orgSlug)
  return storage.run(client, handler)
}

export async function closeGraphDb(): Promise<void> {
  const closePromises: Promise<void>[] = []
  if (databasePerTenantBoltClient) {
    closePromises.push(databasePerTenantBoltClient.close())
    databasePerTenantBoltClient = null
  }
  if (databasePerTenantFalkorDb) {
    closePromises.push(databasePerTenantFalkorDb.close())
    databasePerTenantFalkorDb = null
  }
  for (const driver of instancePerTenantBoltClients.values()) {
    closePromises.push(driver.close())
  }
  instancePerTenantBoltClients.clear()
  await Promise.all(closePromises)
}

export function getGraphClient(): GraphClient {
  const client = storage.getStore()
  if (!client) throw new Error("Call getGraphClient inside withGraphClient.")
  return client
}
