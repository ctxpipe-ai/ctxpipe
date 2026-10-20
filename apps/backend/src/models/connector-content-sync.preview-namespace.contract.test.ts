import { afterEach, expect, it, vi } from "vitest"
import { withOrgIdContext } from "../auth/withAuth.js"
import { parseEnv } from "../config/env.js"
import { withOrgDbContext } from "../db/client.js"
import { connections } from "../db/schema/connections.js"
import { ensureOrgRepositoryForGitUrl } from "../domain/workspaces/ensure-org-repository.js"
import { encodeLinearTokensForDb } from "../lib/connection-config.js"
import { ow } from "../openworkflow/client.js"
import { connectorConfigKey } from "../openworkflow/enqueue-connector-content-sync.js"
import { linearSyncConfig } from "../openworkflow/workflows/linear-sync-config.js"
import { linearSyncContent } from "../openworkflow/workflows/linear-sync-content.js"
import { linearScopeSelection } from "../services/linear/config-yaml.js"
import { withNativeHydrationFixture } from "../test/native-hydration-fixture.js"
import {
  activateConnectorSync,
  findConnectorSyncOwner,
  prepareConnectorSync,
  reconcileConnectorContentSync,
} from "./connector-content-sync.js"
import { getLinearBindingWithRepoByConnectionId } from "./linear-connector.js"

afterEach(() => {
  vi.unstubAllEnvs()
})

it.each(["config", "content"] as const)(
  "admits a Railway preview-namespace connector %s owner and still rejects the production default",
  { timeout: 20_000 },
  async (purpose) => {
    vi.stubEnv("RAILWAY_ENVIRONMENT_NAME", "pr-280")
    await withNativeHydrationFixture(
      { namespaceId: "preview-pr-280", github: true },
      async (f) => {
        const repository = await withOrgIdContext(f.org, () =>
          ensureOrgRepositoryForGitUrl({
            orgId: f.org.id,
            gitUrl: f.workspaceUrl,
            githubConnectionId: f.connectionId,
          }),
        )
        if (!repository) throw new Error("Fixture repository missing")
        const connectionId = `con_${f.id}_preview_${purpose}`
        const config = {
          ...encodeLinearTokensForDb(
            { accessToken: "fixture-preview-namespace", refreshToken: null },
            parseEnv(process.env),
          ),
          ownerUserId: `user_${f.id}`,
          workspaceId: "provider-workspace",
          workspaceName: "Fixture",
          status: "installed",
          repositoryId: repository.id,
          branch: "main",
          enabled: true,
          setupPhase: purpose === "config" ? "config_failed" : "sync_failed",
        }
        await withOrgDbContext(f.org.id, (db) =>
          db.insert(connections).values({
            id: connectionId,
            orgId: f.org.id,
            type: "linear",
            config,
          }),
        )
        const configKey =
          purpose === "config"
            ? `proposal:${connectorConfigKey(linearScopeSelection([]))}`
            : "fixture-config"
        const binding = {
          provider: "linear" as const,
          repositoryId: repository.id,
          branch: "main",
          workspaceId: "provider-workspace",
          cloudId: null,
          atlassianApiBaseUrl: null,
        }
        const intent = await prepareConnectorSync({
          purpose,
          orgId: f.org.id,
          connectionId,
          provider: "linear",
          configKey,
        })
        expect(intent).toMatchObject({
          existingRunId: null,
          contentSyncGeneration: 1,
          contentSyncBinding: binding,
        })
        const input = {
          orgId: f.org.id,
          orgSlug: f.org.slug,
          connectionId,
          configKey,
          contentSyncGeneration: 1,
          contentSyncBinding: binding,
          scopes: [],
        }
        const options = {
          idempotencyKey: `connector-${purpose}:${connectionId}:1:${configKey}`,
        }
        const owner =
          purpose === "config"
            ? await f.runner.runWorkflow(linearSyncConfig.spec, input, options)
            : await f.runner.runWorkflow(linearSyncContent.spec, input, options)
        expect(
          await activateConnectorSync({
            purpose,
            orgId: f.org.id,
            connectionId,
            workflowRunId: owner.workflowRun.id,
          }),
        ).toBe(true)
        expect(
          await findConnectorSyncOwner({
            purpose,
            orgId: f.org.id,
            connectionId,
            provider: "linear",
            idempotencyKey: options.idempotencyKey,
          }),
        ).toBe(owner.workflowRun.id)
        expect(
          await prepareConnectorSync({
            purpose,
            orgId: f.org.id,
            connectionId,
            provider: "linear",
            configKey,
          }),
        ).toMatchObject({ existingRunId: owner.workflowRun.id })
        expect(
          await getLinearBindingWithRepoByConnectionId(f.org.id, connectionId),
        ).toMatchObject({
          setupPhase: purpose === "config" ? "awaiting_merge" : "initial_sync",
        })

        const foreign =
          purpose === "config"
            ? await ow.runWorkflow(linearSyncConfig.spec, input)
            : await ow.runWorkflow(linearSyncContent.spec, input)
        expect(
          await activateConnectorSync({
            purpose,
            orgId: f.org.id,
            connectionId,
            workflowRunId: foreign.workflowRun.id,
          }),
        ).toBe(false)
        expect(
          await findConnectorSyncOwner({
            purpose,
            orgId: "org_other",
            connectionId,
            provider: "linear",
            idempotencyKey: options.idempotencyKey,
          }),
        ).toBeNull()

        await owner.cancel()
        expect(
          await reconcileConnectorContentSync({
            orgId: f.org.id,
            connectionId,
          }),
        ).toBe(true)
        expect(
          await getLinearBindingWithRepoByConnectionId(f.org.id, connectionId),
        ).toMatchObject({
          setupPhase: purpose === "config" ? "config_failed" : "sync_failed",
        })

        await foreign.cancel()
        expect(
          await getLinearBindingWithRepoByConnectionId(f.org.id, connectionId),
        ).toMatchObject({
          setupPhase: purpose === "config" ? "config_failed" : "sync_failed",
        })
      },
    )
  },
)
