import { describe, expect, it } from "vitest"
import {
  ApiKeyEntities,
  pathAfterApiV1,
  requestNeedsWrite,
  resolveRestEntityFromPath,
} from "./apiKeyScopes.js"

describe("apiKeyScopes path helpers", () => {
  it("extracts tail after /api/v1/", () => {
    expect(pathAfterApiV1("/acme/api/v1/repositories")).toBe("repositories")
    expect(pathAfterApiV1("/api/v1/me/github/installations")).toBe(
      "me/github/installations",
    )
  })

  it("maps route prefixes to entities", () => {
    expect(resolveRestEntityFromPath("repositories")).toBe(
      ApiKeyEntities.repositories,
    )
    expect(resolveRestEntityFromPath("connectors/atlassian/foo")).toBe(
      ApiKeyEntities.connectorsAtlassian,
    )
    expect(resolveRestEntityFromPath("connectors/atlassian/pending-claim")).toBe(
      ApiKeyEntities.pendingAtlassianClaim,
    )
    expect(resolveRestEntityFromPath("")).toBe(ApiKeyEntities.health)
  })

  it("detects write methods", () => {
    expect(requestNeedsWrite("GET")).toBe(false)
    expect(requestNeedsWrite("HEAD")).toBe(false)
    expect(requestNeedsWrite("POST")).toBe(true)
  })
})
