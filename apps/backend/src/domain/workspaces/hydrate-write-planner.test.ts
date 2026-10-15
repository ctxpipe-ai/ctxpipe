import { describe, expect, it } from "vitest"
import { bootstrapWorkspaceFiles } from "./bootstrap.js"
import { planHydrateWrites } from "./hydrate-write-planner.js"

const revision = {
  workspaceId: "ws_planner",
  generation: 1,
  remote: { url: "https://github.com/acme/context", connectionId: "con_1" },
  defaultBranch: "main",
  sha: "a".repeat(40),
  access: "read" as const,
}

const bootstrapped = bootstrapWorkspaceFiles({
  displayName: "Context",
  existing: new Map(),
})

const files = [
  ...bootstrapped,
  {
    path: "knowledge/services/billing.md",
    content:
      "---\nkind: Service\ngenerated_by: ctxpipe\nsource: https://github.com/acme/billing#a.ts\n---\n\n# Billing\n",
  },
  {
    path: "knowledge/services/human.md",
    content:
      "---\nkind: Service\nsource: https://github.com/acme/billing#b.ts\n---\n\n# Human\n",
  },
]

function ownershipRemainder(publishPipeline: "legacy" | "v2") {
  return planHydrateWrites({
    revision,
    displayName: "Context",
    files,
    publishPipeline,
  }).find((write) => write.kind === "ownership_migration")
}

describe("hydrate write plan for the ownership migration", () => {
  it("plans the migration of old extracted files when ingestion v2 publishes", () => {
    expect(ownershipRemainder("v2")).toEqual({
      kind: "ownership_migration",
      remainder: 1,
    })
  })

  it("plans no migration while the old pipeline publishes", () => {
    expect(ownershipRemainder("legacy")).toBeUndefined()
  })
})
