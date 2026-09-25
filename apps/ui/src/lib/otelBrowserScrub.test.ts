import { describe, expect, it } from "vitest"
import {
  redactBrowserSecretPath,
  scrubBrowserOtlpJson,
  scrubTelemetrySpanName,
  scrubTelemetryUrl,
} from "./otelBrowserScrub"

describe("scrubTelemetryUrl", () => {
  it("drops query, fragment, and userinfo from absolute URLs", () => {
    expect(
      scrubTelemetryUrl(
        "https://user:pass@backend-pr-343.up.railway.app/.auth/accept-invitation?invitationId=inv_not_real#done",
      ),
    ).toBe(
      "https://backend-pr-343.up.railway.app/.auth/accept-invitation",
    )
  })

  it("drops query and fragment from paths and redacts reset-password tokens", () => {
    expect(
      scrubTelemetryUrl("/.auth/reset-password/super-secret?callbackURL=https://app.example/reset#x"),
    ).toBe("/.auth/reset-password/{token}")
    expect(
      redactBrowserSecretPath(
        "/.auth/api/v1/public/invitations/inv_not_real",
      ),
    ).toBe("/.auth/api/v1/public/invitations/{invitation}")
  })

  it("leaves ordinary text alone", () => {
    expect(scrubTelemetryUrl("Invitation not found or expired")).toBe(
      "Invitation not found or expired",
    )
  })
})

describe("scrubTelemetrySpanName", () => {
  it("scrubs a URL embedded in a span name", () => {
    expect(
      scrubTelemetrySpanName(
        "GET https://backend-pr-343.up.railway.app/.auth/device?user_code=BADCODE",
      ),
    ).toBe("GET https://backend-pr-343.up.railway.app/.auth/device")
  })
})

describe("scrubBrowserOtlpJson", () => {
  it("scrubs nested attributes, arrays, span names, and logs", () => {
    const payload = {
      resourceSpans: [
        {
          resource: {
            attributes: [
              {
                key: "service.name",
                value: { stringValue: "ui" },
              },
            ],
          },
          scopeSpans: [
            {
              spans: [
                {
                  name: "GET /reset-password/sekret?next=1",
                  attributes: [
                    {
                      key: "location.href",
                      value: {
                        stringValue:
                          "https://app.example/.auth/accept-invitation?invitationId=inv_not_real",
                      },
                    },
                    {
                      key: "http.url",
                      value: {
                        arrayValue: {
                          values: [
                            {
                              stringValue:
                                "https://app.example/files?token=abc#part",
                            },
                          ],
                        },
                      },
                    },
                    {
                      key: "note",
                      value: { stringValue: "what?" },
                    },
                  ],
                  events: [
                    {
                      name: "exception",
                      attributes: [
                        {
                          key: "exception.message",
                          value: {
                            stringValue: "Invitation not found or expired",
                          },
                        },
                      ],
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
      resourceLogs: [
        {
          scopeLogs: [
            {
              logRecords: [
                {
                  body: {
                    stringValue:
                      "https://app.example/.auth/device?user_code=BADCODE",
                  },
                  attributes: [
                    {
                      key: "prev.href",
                      value: {
                        kvlistValue: {
                          values: [
                            {
                              key: "href",
                              value: {
                                stringValue: "/obs-e2e-343/chat?x=1#y",
                              },
                            },
                          ],
                        },
                      },
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    }

    scrubBrowserOtlpJson(payload)

    const span = payload.resourceSpans[0]?.scopeSpans[0]?.spans[0]
    expect(span?.name).toBe("GET /reset-password/{token}")
    expect(span?.attributes[0]?.value.stringValue).toBe(
      "https://app.example/.auth/accept-invitation",
    )
    expect(span?.attributes[1]?.value.arrayValue.values[0]?.stringValue).toBe(
      "https://app.example/files",
    )
    expect(span?.attributes[2]?.value.stringValue).toBe("what?")
    expect(span?.events[0]?.attributes[0]?.value.stringValue).toBe(
      "Invitation not found or expired",
    )
    expect(payload.resourceSpans[0]?.resource.attributes[0]?.value.stringValue).toBe(
      "ui",
    )
    const log = payload.resourceLogs[0]?.scopeLogs[0]?.logRecords[0]
    expect(log?.body.stringValue).toBe("https://app.example/.auth/device")
    expect(
      log?.attributes[0]?.value.kvlistValue.values[0]?.value.stringValue,
    ).toBe("/obs-e2e-343/chat")
  })
})
