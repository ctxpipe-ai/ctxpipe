/** Product SLO: mirrored Slack context within ~10 minutes under normal load. */
export const SLACK_THREAD_QUIET_MS = 3 * 60 * 1000
export const SLACK_FLUSH_INTERVAL_MS = 5 * 60 * 1000
export const SLACK_MAX_LAG_MS = 10 * 60 * 1000

export function isSlackDirtyThreadReady(input: {
  lastEventAt: Date
  firstDirtyAt: Date
  now?: Date
}): boolean {
  return msUntilSlackDirtyThreadReady(input) <= 0
}

/** Milliseconds until quiet or max-lag makes the row flushable; 0 if ready now. */
export function msUntilSlackDirtyThreadReady(input: {
  lastEventAt: Date
  firstDirtyAt: Date
  now?: Date
}): number {
  const now = input.now ?? new Date()
  const quietReadyAt = input.lastEventAt.getTime() + SLACK_THREAD_QUIET_MS
  const lagReadyAt = input.firstDirtyAt.getTime() + SLACK_MAX_LAG_MS
  const readyAt = Math.min(quietReadyAt, lagReadyAt)
  return Math.max(0, readyAt - now.getTime())
}

/** 5-minute bucket for flush workflow idempotency keys. */
export function slackFlushIdempotencyBucket(now = new Date()): string {
  return String(Math.floor(now.getTime() / SLACK_FLUSH_INTERVAL_MS))
}
