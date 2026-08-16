import { describe, expect, it } from "vitest"
import {
  cloneRepositoryName,
  originUrlWithoutCredentials,
  repoReadCloneTokenRequest,
  sandboxCanEnforceResourceLimits,
  scrubOriginAfterCloneCommand,
} from "./clone-credentials.js"

describe("clone credentials", () => {
  it("mints a repository-scoped contents:read installation token request", () => {
    expect(cloneRepositoryName("acme/docs.git")).toBe("docs")
    expect(repoReadCloneTokenRequest("https://github.com/acme/docs")).toEqual({
      type: "installation",
      repositoryNames: ["docs"],
      permissions: { contents: "read", metadata: "read" },
    })
  })

  it("scrubs credentials from the origin URL after clone", () => {
    expect(
      originUrlWithoutCredentials(
        "https://x-access-token:secret@github.com/acme/docs.git",
      ),
    ).toBe("https://github.com/acme/docs.git")
    expect(
      scrubOriginAfterCloneCommand("https://github.com/acme/docs.git"),
    ).toBe("git remote set-url origin https://github.com/acme/docs.git")
  })

  it("capability-checks resource limits rather than claiming they are enforced", () => {
    expect(sandboxCanEnforceResourceLimits({ isolation: "docker" })).toEqual({
      cpu: false,
      ram: false,
      pids: false,
      disk: false,
      user: false,
      egress: false,
    })
    expect(
      sandboxCanEnforceResourceLimits({ isolation: "local_process" }).cpu,
    ).toBe(false)
  })
})
