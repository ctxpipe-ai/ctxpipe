import { ClickHouseError } from "@clickhouse/client"
import { describe, expect, it } from "vitest"

import { McpToolError } from "../mcp/framework/tool-errors.js"
import { EmbeddingError } from "../retrieval/embeddings/textEmbeddings.js"
import { JevError } from "../retrieval/jev/client.js"
import { BudgetSpentError, failureOf } from "./failure.js"

/*
 * The source and the code of each error of the plane read (CTX-1645). The
 * wiring through the real plane reader, with real ClickHouse and msw for Jev
 * and the embedding endpoint, is in `knowledge-reader.integration.test.ts`.
 */

/** A message that quotes content, as a provider error can do. */
const secret = "the private text of a customer"

describe("failureOf", () => {
  it.each([
    [
      "a ClickHouse error",
      new ClickHouseError({ message: secret, code: "241", type: "MEMORY" }),
      { kind: "clickhouse", code: "241" },
    ],
    [
      // The HTTP handler refused the request before the query ran, so the
      // client finds no `DB::Exception` in the body and throws an `Error`
      // with the text of the body (CTX-1688).
      "a ClickHouse error that the client does not parse",
      new Error(
        "Poco::Exception. Code: 1000, e.code() = 0, HTML Form Exception: Field value too long, Stack trace (when copying this message, always include the lines below):\n\n0. DB::HTMLForm::readQuery(DB::ReadBuffer&)",
      ),
      { kind: "clickhouse", code: "1000" },
    ],
    [
      "a refused connection",
      Object.assign(new Error(`connect ${secret}`), { code: "ECONNREFUSED" }),
      { kind: "network", code: "ECONNREFUSED" },
    ],
    [
      "an embedding error",
      new EmbeddingError(`Embedding request failed: HTTP 402 ${secret}`, 402),
      { kind: "embedding", code: "402" },
    ],
    [
      "an embedding error with no status",
      new EmbeddingError(secret),
      { kind: "embedding" },
    ],
    [
      "a Jev error",
      new JevError("http", `Jev answered 503: ${secret}`, 503),
      { kind: "jev", code: "http_503" },
    ],
    [
      "a Jev error behind a tool error",
      new McpToolError("judge_unavailable", "The judge did not answer.", {
        cause: new JevError("timeout", secret),
      }),
      { kind: "jev", code: "timeout" },
    ],
    [
      "the end of the time budget",
      new BudgetSpentError(secret),
      { kind: "timeout" },
    ],
    [
      "the end of the budget after a failed embedding",
      new BudgetSpentError(secret, {
        cause: new EmbeddingError(secret, 503),
      }),
      { kind: "embedding", code: "503" },
    ],
    [
      "a tool error",
      new McpToolError("unknown_ref", secret),
      { kind: "tool", code: "unknown_ref" },
    ],
    [
      "any other error",
      new TypeError(secret),
      { kind: "unknown", code: "TypeError" },
    ],
    ["a value that is not an error", secret, { kind: "unknown" }],
  ])("%s", (_, error, expected) => {
    const failure = failureOf(error)
    expect(failure).toEqual(expected)
    expect(JSON.stringify(failure)).not.toContain(secret)
  })
})
