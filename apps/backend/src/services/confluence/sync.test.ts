import { describe, expect, it } from "vitest"
import {
  CONFLUENCE_DELETED_PAGE_EVENT,
  getConfluenceSyncReconcileMode,
} from "./sync.js"

describe("getConfluenceSyncReconcileMode", () => {
  it("returns full when there is no page scoping", () => {
    expect(
      getConfluenceSyncReconcileMode({
        spaceKey: "S",
        eventType: "avi:confluence:updated:page",
      }),
    ).toBe("full")
  })

  it("returns full for page delete events so orphans are pruned in one space run", () => {
    expect(
      getConfluenceSyncReconcileMode({
        spaceKey: "S",
        pageId: "123",
        eventType: CONFLUENCE_DELETED_PAGE_EVENT,
      }),
    ).toBe("full")
  })

  it("returns single_upsert for page create and update", () => {
    expect(
      getConfluenceSyncReconcileMode({
        spaceKey: "S",
        pageId: "123",
        eventType: "avi:confluence:updated:page",
      }),
    ).toBe("single_upsert")
    expect(
      getConfluenceSyncReconcileMode({
        spaceKey: "S",
        pageId: "123",
        eventType: "avi:confluence:created:page",
      }),
    ).toBe("single_upsert")
  })
})
