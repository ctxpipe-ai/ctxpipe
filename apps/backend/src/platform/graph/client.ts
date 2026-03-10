import { AsyncLocalStorage } from "node:async_hooks"
import neo4j, { type Driver } from "neo4j-driver"

const DB_PER_TENANT = ["falkordb", "neo4j-enterprise", "memgraph"] as const
type Provider = (typeof DB_PER_TENANT)[number] | "neo4j-community" | "neptune"

export function getConfig(): {
  uri: string
  user: string
  password: string
  tenancy: "database-per-tenant" | "instance-per-tenant"
} | null {
  const uri = process.env.GRAPH_DB_URI
  if (!uri) return null
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
      (provider === "falkordb" ? "falkordb" : "neo4j"),
    password: process.env.GRAPH_DB_PASSWORD ?? "",
    tenancy,
  }
}

function scopedDriver(inner: Driver, database: string): Driver {
  return new Proxy(inner, {
    get(target, prop) {
      if (prop === "session") {
        return (config: Parameters<Driver["session"]>[0] = {}) =>
          target.session({ ...config, database })
      }
      if (prop === "executeQuery") {
        return (
          query: Parameters<Driver["executeQuery"]>[0],
          params?: Parameters<Driver["executeQuery"]>[1],
          config?: Parameters<Driver["executeQuery"]>[2],
        ) =>
          target.executeQuery(query, params, {
            ...config,
            database,
          } as Parameters<Driver["executeQuery"]>[2])
      }
      return Reflect.get(target, prop)
    },
  }) as Driver
}

let databasePerTenantClient: Driver | null = null
const instancePerTenantClients = new Map<string, Driver>()

async function resolveDriver(orgId: string, orgSlug: string): Promise<Driver> {
  const cfg = getConfig()
  if (!cfg) throw new Error("Graph DB not configured. Set GRAPH_DB_URI.")
  const auth = neo4j.auth.basic(cfg.user, cfg.password)
  if (cfg.tenancy === "database-per-tenant") {
    if (!databasePerTenantClient) {
      databasePerTenantClient = neo4j.driver(cfg.uri, auth)
    }
    return scopedDriver(databasePerTenantClient, orgId)
  }
  const orgUri = process.env[`GRAPH_DB_URI_${orgSlug}`]
  if (!orgUri) {
    throw new Error(`GRAPH_DB_URI_${orgSlug} required for instance-per-tenant.`)
  }
  let driver = instancePerTenantClients.get(orgSlug)
  if (!driver) {
    driver = neo4j.driver(orgUri, auth)
    instancePerTenantClients.set(orgSlug, driver)
  }
  return driver
}

const storage = new AsyncLocalStorage<Driver>()

export async function withGraphClient<T>(
  { orgId, orgSlug }: { orgId: string; orgSlug: string },
  handler: () => Promise<T>,
): Promise<T> {
  const driver = await resolveDriver(orgId, orgSlug)
  return storage.run(driver, handler)
}

export async function closeGraphDb(): Promise<void> {
  const closePromises: Promise<void>[] = []
  if (databasePerTenantClient) {
    closePromises.push(databasePerTenantClient.close())
    databasePerTenantClient = null
  }
  for (const driver of instancePerTenantClients.values()) {
    closePromises.push(driver.close())
  }
  instancePerTenantClients.clear()
  await Promise.all(closePromises)
}

export function getGraphClient(): Driver {
  const driver = storage.getStore()
  if (!driver) throw new Error("Call getGraphClient inside withGraphClient.")
  return driver
}
