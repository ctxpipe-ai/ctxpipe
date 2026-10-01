import { LinearClient } from "@linear/sdk"
import { type DocumentNode, parse } from "graphql"
import { HttpResponse, http } from "msw"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { linearBudgetHeaders } from "../../../test/linear-graphql.js"
import { useMswServer } from "../../../test/msw.js"
import * as generated from "./documents.generated.js"
import {
  estimateLinearQueryComplexity,
  LinearQueryTooComplexError,
  linearGraphql,
  linearQueryComplexityCeiling,
  resetLinearGraphqlForTests,
} from "./graphql.js"

// biome-ignore lint/correctness/useHookAtTopLevel: vitest file-scope MSW setup, not a React hook
const server = useMswServer()

const linearUser = {
  id: "user-1",
  name: "Ada",
  displayName: "Ada",
  active: true,
  admin: false,
  guest: false,
  avatarUrl: null,
}

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

describe("linearGraphql endpoint budgets", () => {
  it("does not park the next query on an exhausted endpoint from the previous one", async () => {
    vi.useFakeTimers()
    let calls = 0
    server.use(
      http.post("https://api.linear.app/graphql", () => {
        calls += 1
        if (calls === 1) {
          return HttpResponse.json(
            { data: { user: linearUser } },
            {
              headers: {
                ...linearBudgetHeaders(),
                "X-RateLimit-Endpoint-Requests-Remaining": "0",
                "X-RateLimit-Endpoint-Requests-Reset": String(
                  Date.now() + 3_600_000,
                ),
                "X-RateLimit-Endpoint-Requests-Name": "issues",
              },
            },
          )
        }
        return HttpResponse.json(
          { data: { user: { ...linearUser, id: "user-2" } } },
          { headers: linearBudgetHeaders() },
        )
      }),
    )
    const client = new LinearClient({ accessToken: "endpoint-isolation" })

    await linearGraphql(
      client,
      generated.UserRecordDocument,
      { id: "user-1" },
      "endpoint-isolation",
    )
    const pending = linearGraphql(
      client,
      generated.UserRecordDocument,
      { id: "user-2" },
      "endpoint-isolation",
    )
    await vi.advanceTimersByTimeAsync(1_000)
    await pending

    expect(calls).toBe(2)
  })
})

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
    let requests = 0
    server.use(
      http.post("https://api.linear.app/graphql", () => {
        requests += 1
        return HttpResponse.json({ data: {} })
      }),
    )
    const client = new LinearClient({ accessToken: "test-token" })
    await expect(
      linearGraphql(client, document, {}, "test-token"),
    ).rejects.toBeInstanceOf(LinearQueryTooComplexError)
    expect(requests).toBe(0)
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
