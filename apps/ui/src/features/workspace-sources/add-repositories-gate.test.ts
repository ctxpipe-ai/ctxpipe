import { describe, expect, it } from "vitest"

import { addRepositoriesGate } from "./add-repositories-gate"

const ready = { formatVersion: 3, codeFormat: 3 }

describe("addRepositoriesGate", () => {
  it("lets a writable Workspace at the newest format add repositories", () => {
    expect(
      addRepositoriesGate({ canEdit: true, readOnlyReason: null, ...ready }),
    ).toBeNull()
  })

  it("gives the reason of a read-only Workspace and points to its settings", () => {
    expect(
      addRepositoriesGate({
        canEdit: false,
        readOnlyReason: "The GitHub App cannot write to the repository.",
        ...ready,
      }),
    ).toEqual({
      title: "Read-only",
      body: "The GitHub App cannot write to the repository.",
      action: "Open Workspace settings",
    })
  })

  it("names the upgrade when the format is below the newest", () => {
    for (const formatVersion of [0, 1, 2])
      expect(
        addRepositoriesGate({
          canEdit: true,
          readOnlyReason: null,
          formatVersion,
          codeFormat: 3,
        }),
      ).toMatchObject({
        title: "Upgrade this Workspace before you add repositories",
        action: "Review upgrades",
      })
  })

  it("waits while the repository has no format yet", () => {
    expect(
      addRepositoriesGate({
        canEdit: true,
        readOnlyReason: null,
        formatVersion: null,
        codeFormat: 3,
      }),
    ).toMatchObject({ title: "Still setting up the Workspace repository" })
  })

  it("is read-only when the format file is not valid or too new", () => {
    for (const formatVersion of [-1, 4])
      expect(
        addRepositoriesGate({
          canEdit: true,
          readOnlyReason: null,
          formatVersion,
          codeFormat: 3,
        }),
      ).toMatchObject({ title: "Read-only", action: "Open Workspace settings" })
  })
})
