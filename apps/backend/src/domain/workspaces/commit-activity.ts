export const COMMIT_RETENTION_DAYS = 396
export const ACTIVITY_CALENDAR_WEEKS = 53

export type ProjectedCommit = {
  sha: string
  committedAt: Date
  authorName: string
  subject: string
  htmlUrl: string | null
}

export type ActivityDay = {
  date: string
  count: number
}

export function utcDateKey(date: Date): string {
  return date.toISOString().slice(0, 10)
}

export function startOfUtcDay(date: Date): Date {
  return new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()),
  )
}

export function startOfUtcSunday(date: Date): Date {
  const day = startOfUtcDay(date)
  day.setUTCDate(day.getUTCDate() - day.getUTCDay())
  return day
}

export function pruneCutoff(now = new Date()): Date {
  return new Date(now.getTime() - COMMIT_RETENTION_DAYS * 86_400_000)
}

export function activityCalendarStart(now = new Date()): Date {
  const today = startOfUtcDay(now)
  return startOfUtcSunday(
    new Date(today.getTime() - (ACTIVITY_CALENDAR_WEEKS - 1) * 7 * 86_400_000),
  )
}

export function activityCalendarDays(input: {
  countsByDate: ReadonlyMap<string, number>
  now?: Date
}): ActivityDay[] {
  const today = startOfUtcDay(input.now ?? new Date())
  const start = activityCalendarStart(input.now ?? new Date())
  const days: ActivityDay[] = []
  for (let time = start.getTime(); time <= today.getTime(); time += 86_400_000) {
    const date = utcDateKey(new Date(time))
    days.push({ date, count: input.countsByDate.get(date) ?? 0 })
  }
  return days
}

export function shouldSkipCommitProjection(input: {
  headSha: string | null
  desiredSha: string | null
  status: string
}): boolean {
  return (
    input.status === "ready" &&
    input.desiredSha != null &&
    input.headSha === input.desiredSha
  )
}

export function mergeCommitPage(input: {
  existingShas: ReadonlySet<string>
  commits: readonly ProjectedCommit[]
}): { toInsert: ProjectedCommit[]; hitKnownSha: boolean } {
  const toInsert: ProjectedCommit[] = []
  let hitKnownSha = false
  for (const commit of input.commits) {
    if (input.existingShas.has(commit.sha)) {
      hitKnownSha = true
      continue
    }
    toInsert.push(commit)
  }
  return { toInsert, hitKnownSha }
}

export function firstLineSubject(message: string): string {
  const line = message.split("\n")[0]?.trim() ?? ""
  return line || "Commit"
}
