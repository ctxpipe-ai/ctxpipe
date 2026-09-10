export const requiredStories = [
  "FirstMessageSendsOnceInStrictMode",
  "LateErrorDoesNotClobberSuccess",
  "SocketCleansUpOnLeave",
  "ReloadReconnects",
  "RapidRouteChanges",
  "EditThenNavigate",
  "OutOfOrderSaves",
  "PierreKeyboardFocus",
  "SharedPublishPending",
  "StableRequestBudget",
  "StableFilesRequestBudget",
]

export function isGoldenPlaySuccess(phase) {
  return phase === "played"
}

export function selectGoldenStories(index) {
  const entries = Object.values(index.entries ?? {})
  return requiredStories.map((name) => {
    const story = entries.find(
      (entry) =>
        entry.exportName === name &&
        (entry.tags ?? []).includes("workspace-golden"),
    )
    if (!story) throw new Error(`Missing tagged golden story ${name}`)
    if (!(story.tags ?? []).includes("play-fn"))
      throw new Error(
        `${name} is tagged workspace-golden but has no play function`,
      )
    return story
  })
}
