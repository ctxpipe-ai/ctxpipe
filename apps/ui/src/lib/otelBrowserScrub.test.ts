import { describe, expect, it } from "vitest"
import { scrubOtlpJsonText } from "./otelBrowserScrub"

describe("scrubOtlpJsonText", () => {
  it("drops empty identity attributes and keeps the rest", () => {
    const parsed = scrubOtlpJsonText(
      JSON.stringify({
        resourceSpans: [
          {
            scopeSpans: [
              {
                spans: [
                  {
                    attributes: [
                      { key: "userId", value: { stringValue: "" } },
                      { key: "teamId", value: { stringValue: "" } },
                      { key: "teamName", value: { stringValue: "" } },
                      { key: "enduser.id", value: { stringValue: "" } },
                      { key: "ctxpipe.org.id", value: { stringValue: "" } },
                      { key: "ctxpipe.org.slug", value: { stringValue: "" } },
                      { key: "userId", value: { stringValue: "user_1" } },
                      { key: "teamId", value: { intValue: "0" } },
                      { key: "note", value: { stringValue: "" } },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      }),
    ) as {
      resourceSpans: Array<{
        scopeSpans: Array<{
          spans: Array<{ attributes: Array<{ key: string }> }>
        }>
      }>
    }
    expect(
      parsed.resourceSpans[0]?.scopeSpans[0]?.spans[0]?.attributes.map(
        (attribute) => attribute.key,
      ),
    ).toEqual(["userId", "teamId", "note"])
  })
})
