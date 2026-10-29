import { describe, expect, it } from "vitest"

import { parseSourceEntry } from "../sources-file.js"
import { BUILDKITE_SOURCE_MAX_PIPELINES } from "./buildkite.js"
import {
  CONFLUENCE_SOURCE_MAX_PAGES_PER_SPACE,
  CONFLUENCE_SOURCE_MAX_SPACES,
} from "./confluence.js"
import { GITHUB_SOURCE_MAX_REPOSITORIES } from "./github.js"
import {
  LINEAR_SOURCE_MAX_PROJECTS,
  LINEAR_SOURCE_MAX_TEAMS,
} from "./linear.js"
import {
  NOTION_SOURCE_MAX_DATABASES,
  NOTION_SOURCE_MAX_PAGES,
} from "./notion.js"
import { PAGERDUTY_SOURCE_MAX_SERVICES } from "./pagerduty.js"
import { SLACK_SOURCE_MAX_CHANNELS } from "./slack.js"

const ids = (count: number, make: (i: number) => string) =>
  Array.from({ length: count }, (_, i) => make(i))

const notionId = (i: number) =>
  `1a2b3c4d-0000-4000-8000-${String(i).padStart(12, "0")}`

/**
 * Each capped list: the provider, the list key, the cap, a scope with
 * `count` items in the list, and the message that the API and the UI show.
 */
const lists = [
  {
    provider: "pagerduty",
    max: PAGERDUTY_SOURCE_MAX_SERVICES,
    scope: (n: number) => ({ services: ids(n, (i) => `PSVC${i}`) }),
    message: `services: Select at most ${PAGERDUTY_SOURCE_MAX_SERVICES} PagerDuty services`,
  },
  {
    provider: "buildkite",
    max: BUILDKITE_SOURCE_MAX_PIPELINES,
    scope: (n: number) => ({ pipelines: ids(n, (i) => `pipeline-${i}`) }),
    message: `pipelines: Select at most ${BUILDKITE_SOURCE_MAX_PIPELINES} Buildkite pipelines`,
  },
  {
    provider: "slack",
    max: SLACK_SOURCE_MAX_CHANNELS,
    scope: (n: number) => ({ channels: ids(n, (i) => `C0${i}ABC`) }),
    message: `channels: Select at most ${SLACK_SOURCE_MAX_CHANNELS} Slack channels`,
  },
  {
    provider: "linear",
    max: LINEAR_SOURCE_MAX_TEAMS,
    scope: (n: number) => ({ teams: ids(n, (i) => `T${i}`) }),
    message: `teams: Select at most ${LINEAR_SOURCE_MAX_TEAMS} Linear teams`,
  },
  {
    provider: "linear",
    max: LINEAR_SOURCE_MAX_PROJECTS,
    scope: (n: number) => ({ projects: ids(n, (i) => `project-${i}`) }),
    message: `projects: Select at most ${LINEAR_SOURCE_MAX_PROJECTS} Linear projects`,
  },
  {
    provider: "notion",
    max: NOTION_SOURCE_MAX_PAGES,
    scope: (n: number) => ({
      pages: ids(n, (i) => notionId(i)).map((id) => ({ id, title: id })),
    }),
    message: `pages: Select at most ${NOTION_SOURCE_MAX_PAGES} Notion pages`,
  },
  {
    provider: "notion",
    max: NOTION_SOURCE_MAX_DATABASES,
    scope: (n: number) => ({
      databases: ids(n, (i) => notionId(i)).map((id) => ({ id, title: id })),
    }),
    message: `databases: Select at most ${NOTION_SOURCE_MAX_DATABASES} Notion databases`,
  },
  {
    provider: "confluence",
    max: CONFLUENCE_SOURCE_MAX_SPACES,
    scope: (n: number) => ({
      spaces: ids(n, (i) => `S${i}`).map((key) => ({ key, pages: "all" })),
    }),
    message: `spaces: Select at most ${CONFLUENCE_SOURCE_MAX_SPACES} Confluence spaces`,
  },
  {
    provider: "confluence",
    max: CONFLUENCE_SOURCE_MAX_PAGES_PER_SPACE,
    scope: (n: number) => ({
      spaces: [{ key: "ENG", pages: ids(n, (i) => String(i + 1)) }],
    }),
    message: `spaces.0.pages: Select at most ${CONFLUENCE_SOURCE_MAX_PAGES_PER_SPACE} pages in one Confluence space`,
  },
  {
    provider: "github",
    max: GITHUB_SOURCE_MAX_REPOSITORIES,
    scope: (n: number) => ({ repositories: ids(n, (i) => `acme/repo-${i}`) }),
    message: `repositories: Select at most ${GITHUB_SOURCE_MAX_REPOSITORIES} repositories`,
  },
]

const entry = (provider: string, scope: Record<string, unknown>) =>
  parseSourceEntry({
    id: "capped",
    provider,
    connection: "con_abc123",
    ...scope,
  })

describe("source scope list caps", () => {
  it.each(lists)(
    "$provider accepts $max items in the list",
    ({ provider, max, scope }) => {
      expect(entry(provider, scope(max)).ok).toBe(true)
    },
  )

  it.each(lists)(
    "$provider rejects one item above the cap with a clear message",
    ({ provider, max, scope, message }) => {
      const parsed = entry(provider, scope(max + 1))
      expect(parsed.ok).toBe(false)
      expect(parsed.ok ? null : parsed.detail).toBe(message)
    },
  )
})
