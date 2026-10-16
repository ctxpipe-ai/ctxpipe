import { describe, expect, it } from "vitest"
import {
  isOutsideFault,
  parseGithubCoreLimit,
} from "./github-rate-limit-reply.js"

const caught = (run: () => unknown): unknown => {
  try {
    run()
  } catch (e) {
    return e
  }
  return undefined
}

const ok = (stdout: string) => ({ exitCode: 0, stdout, stderr: "" })

describe("parseGithubCoreLimit", () => {
  it("reads the core limit", () => {
    expect(
      parseGithubCoreLimit(ok('{"resources":{"core":{"limit":5000}}}\n200')),
    ).toBe(5000)
  })

  it("names an empty body with status 200 as a firewall fault, not a JSON error", () => {
    expect(() => parseGithubCoreLimit(ok("\n200"))).toThrow(
      /Firewall fault.*not JSON/,
    )
  })

  it("names a dropped connection as an outside fault", () => {
    const error = caught(() =>
      parseGithubCoreLimit({
        exitCode: 52,
        stdout: "",
        stderr: "Empty reply",
      }),
    )
    expect(String(error)).toMatch(/Outside fault.*exit 52/)
    expect(isOutsideFault(error)).toBe(true)
  })

  it("names 403 and 429 as rate limited and 5xx as GitHub down", () => {
    expect(() =>
      parseGithubCoreLimit(ok('{"message":"rate limit"}\n429')),
    ).toThrow(/Outside fault: GitHub rate limited/)
    expect(() => parseGithubCoreLimit(ok("\n403"))).toThrow(/rate limited/)
    expect(() => parseGithubCoreLimit(ok("\n503"))).toThrow(
      /Outside fault.*503/,
    )
  })

  it("names an unresolved host as a firewall fault that is not retried", () => {
    const error = caught(() =>
      parseGithubCoreLimit({
        exitCode: 6,
        stdout: "",
        stderr: "Could not resolve host",
      }),
    )
    expect(String(error)).toMatch(/Firewall fault/)
    expect(isOutsideFault(error)).toBe(false)
  })
})
