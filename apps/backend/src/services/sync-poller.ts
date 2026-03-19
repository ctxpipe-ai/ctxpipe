import { withSystemOrgContext } from "../auth/context.js"
import type { Env } from "../config/env.js"
import { withOrgDbContext } from "../db/client.js"
import { listAllEnabledConnectors } from "../models/connectors.js"
import { syncOrchestrator } from "./confluence/index.js"
import { buildConfluenceConfig } from "./confluence/config.js"

type ConnectorRecord = Awaited<ReturnType<typeof listAllEnabledConnectors>>[number]

async function syncConnector(connector: ConnectorRecord) {
  const config = connector.config
  const confluenceConfig = buildConfluenceConfig(config)
  if (!confluenceConfig) {
    console.log(`[poller] skipping connector ${connector.id} — no valid credentials`)
    return
  }

  if (!connector.githubRepoName || !config.githubToken) {
    console.log(`[poller] skipping connector ${connector.id} — GitHub not configured`)
    return
  }

  const parts = connector.githubRepoName.split("/")
  if (parts.length !== 2) {
    console.log(`[poller] skipping connector ${connector.id} — invalid repo name ${connector.githubRepoName}`)
    return
  }
  const [owner, repo] = parts as [string, string]

  return withOrgDbContext(connector.orgId, () =>
    withSystemOrgContext(connector.orgId, () =>
      syncOrchestrator.sync({
        connectorId: connector.id,
        orgId: connector.orgId,
        confluenceConfig,
        githubConfig: {
          token: config.githubToken!,
          owner,
          repo,
          branch: connector.githubBranch ?? "main",
        },
        syncMode: config.syncMode ?? "auto",
      }),
    ),
  )
}

export class SyncPoller {
  private intervalMs: number
  private timer: ReturnType<typeof setTimeout> | null = null
  private inProgress = new Set<string>()

  constructor(intervalMinutes: number) {
    this.intervalMs = intervalMinutes * 60 * 1000
  }

  start(): void {
    console.log(`[poller] starting — interval=${this.intervalMs / 60000}min`)
    this.scheduleNext(0)
  }

  stop(): void {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    console.log("[poller] stopped")
  }

  private scheduleNext(delayMs: number): void {
    this.timer = setTimeout(() => {
      void this.runCycle().finally(() => this.scheduleNext(this.intervalMs))
    }, delayMs)
  }

  private async runCycle(): Promise<void> {
    let connectors: Awaited<ReturnType<typeof listAllEnabledConnectors>>
    try {
      connectors = await listAllEnabledConnectors()
    } catch (err) {
      console.error("[poller] failed to list connectors:", err)
      return
    }

    const confluenceConnectors = connectors.filter((c) => c.type === "confluence")
    if (confluenceConnectors.length === 0) return

    console.log(`[poller] cycle — ${confluenceConnectors.length} connector(s) to sync`)

    // Stagger syncs evenly across the interval so we don't burst at once.
    // Each connector fires at: (index / total) * intervalMs into the cycle.
    const staggerMs = this.intervalMs / confluenceConnectors.length

    for (let i = 0; i < confluenceConnectors.length; i++) {
      const connector = confluenceConnectors[i]!
      const delay = Math.round(i * staggerMs)

      setTimeout(() => {
        if (this.inProgress.has(connector.id)) {
          console.log(`[poller] skipping ${connector.id} — previous sync still running`)
          return
        }
        this.inProgress.add(connector.id)
        syncConnector(connector)
          .then((result) => {
            if (result && !result.success) {
              console.error(`[poller] sync failed: ${connector.id} — ${result.error}`)
            } else {
              console.log(`[poller] sync complete: ${connector.id}`)
            }
          })
          .catch((err) => console.error(`[poller] sync error: ${connector.id}`, err))
          .finally(() => this.inProgress.delete(connector.id))
      }, delay)
    }
  }
}

let poller: SyncPoller | null = null

export function startSyncPoller(env: Env): void {
  if (poller) return
  poller = new SyncPoller(env.SYNC_INTERVAL_MINUTES)
  poller.start()
}

export function stopSyncPoller(): void {
  poller?.stop()
  poller = null
}
