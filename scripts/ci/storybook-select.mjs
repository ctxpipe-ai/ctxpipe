// Every story tagged `required`, sorted by id so shards stay stable.
export function selectRequiredStories(index) {
  const tagged = Object.values(index.entries ?? {}).filter((entry) =>
    (entry.tags ?? []).includes("required"),
  )
  for (const story of tagged)
    if (!(story.tags ?? []).includes("play-fn"))
      throw new Error(`${story.id} is tagged required but has no play function`)
  return tagged.sort((a, b) => (a.id < b.id ? -1 : 1))
}

// Every story, sorted by id so shards stay stable: the nightly trace renders
// each story, also one without a play function (its screenshot check needs
// its lines).
export function selectTracedStories(index) {
  return Object.values(index.entries ?? {})
    .filter((entry) => entry.type === "story")
    .sort((a, b) => (a.id < b.id ? -1 : 1))
}

// Every story with a play function, sorted by id so shards stay stable.
export function selectPlayStories(index) {
  return Object.values(index.entries ?? {})
    .filter(
      (entry) =>
        entry.type === "story" && (entry.tags ?? []).includes("play-fn"),
    )
    .sort((a, b) => (a.id < b.id ? -1 : 1))
}

// "i/n" keeps every n-th story, starting at the i-th, so the shards cover all
// stories once. Without a spec, every story stays.
export function shardStories(stories, spec) {
  if (!spec) return stories
  const [at, count] = spec.split("/").map(Number)
  if (
    !(Number.isInteger(at) && Number.isInteger(count) && at >= 1 && at <= count)
  )
    throw new Error(`Bad shard ${spec}; use i/n with 1 <= i <= n`)
  return stories.filter((_, position) => position % count === at - 1)
}
