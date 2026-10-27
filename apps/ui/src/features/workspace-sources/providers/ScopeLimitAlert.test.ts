import { confluenceSourceScopeSchema } from "backend/domain/workspace-sources/providers/confluence"
import {
  PAGERDUTY_SOURCE_MAX_SERVICES,
  pagerdutySourceScopeSchema,
} from "backend/domain/workspace-sources/providers/pagerduty"
import {
  PLAIN_SOURCE_MAX_ITEMS,
  plainSourceScopeSchema,
} from "backend/domain/workspace-sources/providers/plain"
import { describe, expect, it } from "vitest"

import { scopeLimitMessage } from "./ScopeLimitAlert"

const services = (count: number) =>
  Array.from({ length: count }, (_, i) => `PSVC${i}`)

describe("scopeLimitMessage", () => {
  it("gives the schema message when a list is above its cap", () => {
    expect(
      scopeLimitMessage(pagerdutySourceScopeSchema, {
        services: services(PAGERDUTY_SOURCE_MAX_SERVICES + 1),
      }),
    ).toBe(`Select at most ${PAGERDUTY_SOURCE_MAX_SERVICES} PagerDuty services`)
  })

  it("gives the message of the Plain list that is above its cap", () => {
    const labels = Array.from(
      { length: PLAIN_SOURCE_MAX_ITEMS + 1 },
      (_, i) => `lt_${i}`,
    )
    expect(
      scopeLimitMessage(plainSourceScopeSchema, { helpCenters: [], labels }),
    ).toBe(`Select at most ${PLAIN_SOURCE_MAX_ITEMS} labels`)
  })

  it("gives null at the cap and for other errors", () => {
    expect(
      scopeLimitMessage(pagerdutySourceScopeSchema, {
        services: services(PAGERDUTY_SOURCE_MAX_SERVICES),
      }),
    ).toBeNull()
    expect(
      scopeLimitMessage(pagerdutySourceScopeSchema, { services: [] }),
    ).toBeNull()
    expect(
      scopeLimitMessage(confluenceSourceScopeSchema, {
        spaces: [{ key: "ENG", pages: "x".repeat(300) }],
      }),
    ).toBeNull()
  })
})
