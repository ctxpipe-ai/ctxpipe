import { ClickHouseError } from "@clickhouse/client"

import { McpToolError } from "../mcp/framework/tool-errors.js"
import { EmbeddingError } from "../retrieval/embeddings/textEmbeddings.js"
import { JevError } from "../retrieval/jev/client.js"
import type { ModelMeter } from "./orchestrator.js"

/**
 * The source of an error of the plane read (CTX-1645):
 * - `clickhouse`: the ClickHouse server answered with an error. The code is
 *   the ClickHouse error code.
 * - `network`: a connection failed (in the plane read, to ClickHouse). The
 *   code is the system error code, for example `ECONNREFUSED`.
 * - `embedding`: the query embedding failed. The code is the HTTP status,
 *   when the endpoint gave one.
 * - `jev`: the Jev call failed. The code is the Jev error kind, with the
 *   HTTP status when there is one (`http_503`).
 * - `timeout`: the time budget of the read ended. The 3-second budget ends
 *   before the time limit of the ClickHouse client (30 s), so a timeout of
 *   the client itself is `unknown`.
 * - `tool`: the plane refused the call. The code is the tool error code.
 * - `unknown`: any other error. The code is the class name of the error.
 */
type FailureKind =
  | "clickhouse"
  | "network"
  | "embedding"
  | "jev"
  | "timeout"
  | "tool"
  | "unknown"

export type Failure = { kind: FailureKind; code?: string }

/** The time budget of a retrieval ended before a step could start or end. */
export class BudgetSpentError extends Error {
  override readonly name = "BudgetSpentError"
}

/**
 * Keep the source and the code of `error` as the cause of a partial answer,
 * when it is the first.
 */
export function notePartial(meter: ModelMeter, error: unknown): void {
  meter.partialCause ??= failureOf(error)
}

/**
 * The source and the code of `error`, with no message: a message can quote
 * content. An error with a cause (a tool error, or the end of the budget
 * after a failed embedding) gives the source of its cause.
 */
export function failureOf(error: unknown): Failure {
  if (error instanceof McpToolError)
    return error.cause === undefined
      ? { kind: "tool", code: error.code }
      : failureOf(error.cause)
  if (error instanceof BudgetSpentError)
    return error.cause === undefined
      ? { kind: "timeout" }
      : failureOf(error.cause)
  if (error instanceof ClickHouseError)
    return { kind: "clickhouse", code: error.code }
  if (error instanceof EmbeddingError)
    return error.status === undefined
      ? { kind: "embedding" }
      : { kind: "embedding", code: String(error.status) }
  if (error instanceof JevError)
    return {
      kind: "jev",
      code:
        error.status === undefined
          ? error.kind
          : `${error.kind}_${error.status}`,
    }
  if (!(error instanceof Error)) return { kind: "unknown" }
  // A Node.js system error, for example a refused connection.
  if ("code" in error && typeof error.code === "string")
    if (/^E[A-Z_]+$/.test(error.code))
      return { kind: "network", code: error.code }
  return { kind: "unknown", code: error.name }
}
