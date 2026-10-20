import { describe, expect, it } from "vitest"
import {
  parseUserPreferences,
  SIDE_NAV_DEFAULT_WIDTH,
  upgradeDismissKey,
  withDismissedUpgrade,
} from "./user-preferences"

describe("parseUserPreferences", () => {
  it("gives defaults for no value or a value that is not JSON", () => {
    const defaults = {
      selectedOrganizationSlug: null,
      isSideNavExpanded: true,
      sideNavWidth: SIDE_NAV_DEFAULT_WIDTH,
      orgGuides: {},
      dismissedUpgrades: [],
    }
    expect(parseUserPreferences(null)).toEqual(defaults)
    expect(parseUserPreferences("{not json")).toEqual(defaults)
    expect(parseUserPreferences("[1,2]")).toEqual(defaults)
  })

  it("keeps the known guide fields of each user and organization", () => {
    const parsed = parseUserPreferences(
      JSON.stringify({
        selectedOrganizationSlug: "acme",
        orgGuides: {
          "user_1:acme": {
            collapsed: true,
            dismissedAt: "2026-10-01T00:00:00.000Z",
            completedAt: "2026-10-02T00:00:00.000Z",
            exploredAt: "2026-10-03T00:00:00.000Z",
            hintsSeen: ["panes", "add-workspace"],
            somethingElse: 1,
          },
        },
      }),
    )
    expect(parsed.selectedOrganizationSlug).toBe("acme")
    expect(parsed.orgGuides).toEqual({
      "user_1:acme": {
        collapsed: true,
        dismissedAt: "2026-10-01T00:00:00.000Z",
        completedAt: "2026-10-02T00:00:00.000Z",
        exploredAt: "2026-10-03T00:00:00.000Z",
        hintsSeen: ["panes", "add-workspace"],
      },
    })
  })

  it("drops malformed guide values", () => {
    const parsed = parseUserPreferences(
      JSON.stringify({
        orgGuides: {
          "user_1:acme": {
            collapsed: "yes",
            dismissedAt: 12,
            completedAt: "not a date",
            hintsSeen: ["panes", 3, null],
          },
          "user_1:other": "nope",
          "user_1:list": [],
        },
      }),
    )
    expect(parsed.orgGuides).toEqual({
      "user_1:acme": { hintsSeen: ["panes"] },
    })
    expect(parseUserPreferences('{"orgGuides":[1]}').orgGuides).toEqual({})
  })
})

describe("dismissed upgrades", () => {
  const key = upgradeDismissKey({
    orgSlug: "acme",
    workspaceSlug: "docs",
    key: "format-3",
    status: "awaiting_operator",
  })

  it("names the item and its state, so a changed item shows again", () => {
    expect(key).toBe("acme/docs/format-3/awaiting_operator")
    expect(
      upgradeDismissKey({
        orgSlug: "acme",
        workspaceSlug: "docs",
        key: "format-3",
        status: "failed",
      }),
    ).not.toBe(key)
  })

  it("keeps each key one time, and keeps only the strings of a stored value", () => {
    const once = withDismissedUpgrade(parseUserPreferences(null), key)
    expect(withDismissedUpgrade(once, key).dismissedUpgrades).toEqual([key])
    expect(
      parseUserPreferences(JSON.stringify({ dismissedUpgrades: [key, 3] }))
        .dismissedUpgrades,
    ).toEqual([key])
  })

  it("drops the oldest key after 100 keys", () => {
    let preferences = parseUserPreferences(null)
    for (let index = 0; index < 101; index++)
      preferences = withDismissedUpgrade(preferences, `key-${index}`)
    expect(preferences.dismissedUpgrades).toHaveLength(100)
    expect(preferences.dismissedUpgrades[0]).toBe("key-1")
  })
})
