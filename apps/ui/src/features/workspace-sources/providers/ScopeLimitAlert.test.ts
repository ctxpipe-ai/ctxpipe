import { confluenceSourceScopeSchema } from "backend/domain/workspace-sources/providers/confluence"
import {
  PAGERDUTY_SOURCE_MAX_SERVICES,
  pagerdutySourceScopeSchema,
} from "backend/domain/workspace-sources/providers/pagerduty"
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
