import { describe, expect, test } from "bun:test"
import { otlpHeaders } from "./index"

describe("otlpHeaders", () => {
  test("sends no headers to the in-VPC collector when OTEL_EXPORTER_OTLP_HEADERS is not set", () => {
    expect(otlpHeaders("")).toEqual({})
  })

  test("decodes the headers of OTEL_EXPORTER_OTLP_HEADERS when it is set", () => {
    expect(otlpHeaders("cf-access-client-id=id, cf-access-client-secret=a%3Db,bad")).toEqual({
      "cf-access-client-id": "id",
      "cf-access-client-secret": "a=b",
    })
  })
})
