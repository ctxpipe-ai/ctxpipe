import { LinearClient } from "@linear/sdk"
import { type DocumentNode, parse } from "graphql"
import { beforeEach, describe, expect, it, vi } from "vitest"
import * as generated from "./documents.generated.js"
import {
  estimateLinearQueryComplexity,
  LinearQueryTooComplexError,
  linearGraphql,
  linearQueryComplexityCeiling,
  resetLinearGraphqlForTests,
} from "./graphql.js"

beforeEach(() => {
  resetLinearGraphqlForTests()
  vi.useRealTimers()
})

function isDocument(value: unknown): value is DocumentNode {
  return (
    typeof value === "object" &&
    value !== null &&
    "kind" in value &&
    value.kind === "Document" &&
    "definitions" in value &&
    Array.isArray(value.definitions) &&
    value.definitions.some(
      (definition) =>
        typeof definition === "object" &&
        definition !== null &&
        "kind" in definition &&
        definition.kind === "OperationDefinition",
    )
  )
}

describe("estimateLinearQueryComplexity", () => {
  it("rejects a document whose first arguments exceed the per-query ceiling", async () => {
    const document = parse(`query Fat {
      issues(first: 50) {
        nodes {
          comments(first: 50) { nodes { id body } }
          labels(first: 50) { nodes { id name } }
          attachments(first: 50) { nodes { id title url } }
        }
      }
    }`)
    expect(estimateLinearQueryComplexity(document)).toBeGreaterThan(
      linearQueryComplexityCeiling,
    )
    const client = new LinearClient({ accessToken: "test-token" })
    const rawRequest = vi.spyOn(client.client, "rawRequest")
    await expect(linearGraphql(client, document, {})).rejects.toBeInstanceOf(
      LinearQueryTooComplexError,
    )
    expect(rawRequest).not.toHaveBeenCalled()
  })

  it.each(
    Object.entries(generated).filter(
      (entry): entry is [string, DocumentNode] =>
        entry[0].endsWith("Document") && isDocument(entry[1]),
    ),
  )("%s stays at or under 8000 points", (_name, document) => {
    expect(estimateLinearQueryComplexity(document)).toBeLessThanOrEqual(
      linearQueryComplexityCeiling,
    )
  })
})
