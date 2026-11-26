import { log } from "evlog"

/** The network code of a failed export: Bun sets `code`, Node `cause.code`. */
function errorCode(error: unknown): string | undefined {
  if (!(error instanceof Error)) return undefined
  const own = (error as { code?: unknown }).code
  if (typeof own === "string") return own
  const cause = (error as { cause?: { code?: unknown } }).cause?.code
  return typeof cause === "string" ? cause : undefined
}

/**
 * Returns the report for the failed exports of one telemetry signal. A
 * failed export never throws and never stops the process: the collector can
 * be down for a long time (CTX-1705). The report logs one
 * `otlp.export-failed` error at most once a minute. When the caller gives
 * the dropped records (the log pipeline does; the OTel SDK does not), the
 * line has their count since the last line in `droppedEvents`. The time of
 * the line is set before the line is written: the line goes to the log
 * export too, and its own drop must not write a second line.
 */
export function exportFailureReport(
  signal: "logs" | "traces and metrics",
): (error: unknown, droppedRecords?: number) => void {
  let loggedAt = Number.NEGATIVE_INFINITY
  let dropped: number | undefined
  return (error, droppedRecords) => {
    if (droppedRecords !== undefined) dropped = (dropped ?? 0) + droppedRecords
    if (Date.now() - loggedAt < 60_000) return
    loggedAt = Date.now()
    const droppedEvents = dropped
    dropped = undefined
    log.error({
      step: "otlp.export-failed",
      message:
        droppedEvents === undefined
          ? `The ${signal} export to the collector failed`
          : `The ${signal} export to the collector failed; ${droppedEvents} records dropped since the last report`,
      signal,
      droppedEvents,
      code: errorCode(error),
      error: error instanceof Error ? error.message : String(error),
    })
  }
}
