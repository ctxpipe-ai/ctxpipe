/** Product SLO: mirrored Slack context within ~10 minutes under normal load. */
export const SLACK_THREAD_QUIET_MS = 3 * 60 * 1000
export const SLACK_FLUSH_INTERVAL_MS = 5 * 60 * 1000
export const SLACK_MAX_LAG_MS = 10 * 60 * 1000

export function isSlackDirtyThreadReady(input: {
  lastEventAt: Date
  firstDirtyAt: Date
  now?: Date
}): boolean {
  const now = input.now ?? new Date()
  const quietElapsed = now.getTime() - input.lastEventAt.getTime()
  const lagElapsed = now.getTime() - input.firstDirtyAt.getTime()
  return (
    quietElapsed >= SLACK_THREAD_QUIET_MS || lagElapsed >= SLACK_MAX_LAG_MS
  )
}

/** 5-minute bucket for flush workflow idempotency keys. */
export function slackFlushIdempotencyBucket(now = new Date()): string {
  return String(Math.floor(now.getTime() / SLACK_FLUSH_INTERVAL_MS))
}
