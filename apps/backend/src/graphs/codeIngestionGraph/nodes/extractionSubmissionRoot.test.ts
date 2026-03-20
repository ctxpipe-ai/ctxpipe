import { describe, expect, it } from "vitest"
import {
  findMatchingRoot,
  resolveSubmissionRoot,
} from "./extractionSubmissionRoot.js"

describe("extractionSubmissionRoot", () => {
  const multi = ["./", "apps/web", "packages/shared"]

  it("findMatchingRoot picks the longest matching root", () => {
    expect(findMatchingRoot("apps/web/src", multi)).toBe("apps/web")
    expect(findMatchingRoot("./", multi)).toBe("./")
    expect(findMatchingRoot("packages/shared/lib", multi)).toBe("packages/shared")
  })

  it("resolveSubmissionRoot returns null when only ./ matches but other roots exist", () => {
    expect(resolveSubmissionRoot("vendor/unknown", multi)).toBeNull()
  })

  it("resolveSubmissionRoot allows ./ fallback when roots is only ./", () => {
    expect(resolveSubmissionRoot("apps/web", ["./"])).toBe("./")
  })

  it("resolveSubmissionRoot uses apps/web for paths under that root", () => {
    expect(resolveSubmissionRoot("apps/web", multi)).toBe("apps/web")
  })
})
