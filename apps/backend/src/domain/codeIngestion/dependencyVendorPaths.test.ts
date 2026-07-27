import { describe, expect, it } from "vitest"
import { isUnderDependencyVendorPath } from "./dependencyVendorPaths.js"

describe("isUnderDependencyVendorPath", () => {
  it("returns true for paths under known dependency directory segments", () => {
    expect(isUnderDependencyVendorPath("vendor/foo/README.md")).toBe(true)
    expect(isUnderDependencyVendorPath("apps/backend/vendor/foo/README.md")).toBe(
      true,
    )
    expect(isUnderDependencyVendorPath("node_modules/pkg/readme.md")).toBe(true)
    expect(isUnderDependencyVendorPath("lib/third_party/x/AGENTS.md")).toBe(true)
    expect(isUnderDependencyVendorPath("external/bazel/foo.md")).toBe(true)
    expect(isUnderDependencyVendorPath("Pods/MyPod/README.md")).toBe(true)
    expect(isUnderDependencyVendorPath("Godeps/_workspace/src/foo.md")).toBe(true)
  })

  it("returns false for owned project paths and ambiguous segment names", () => {
    expect(isUnderDependencyVendorPath("apps/foo/README.md")).toBe(false)
    expect(isUnderDependencyVendorPath("packages/aws-cdk/README.md")).toBe(false)
    expect(isUnderDependencyVendorPath("internal/vendor-portal/AGENTS.md")).toBe(
      false,
    )
    expect(isUnderDependencyVendorPath("internal/vendor/onboarding/AGENTS.md")).toBe(
      false,
    )
    expect(isUnderDependencyVendorPath("lib/external/foo.md")).toBe(false)
    expect(isUnderDependencyVendorPath("AGENTS.md")).toBe(false)
    expect(isUnderDependencyVendorPath("deps/my-lib/README.md")).toBe(false)
    expect(isUnderDependencyVendorPath("lib/utils/README.md")).toBe(false)
  })

  it("matches segment names case-insensitively", () => {
    expect(isUnderDependencyVendorPath("VENDOR/foo/README.md")).toBe(true)
    expect(isUnderDependencyVendorPath("Node_Modules/pkg/readme.md")).toBe(true)
    expect(isUnderDependencyVendorPath("internal/VENDOR/onboarding/AGENTS.md")).toBe(
      false,
    )
  })
})
