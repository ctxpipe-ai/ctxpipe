import { toOTLPLogRecord } from "evlog/otlp"
import { describe, expect, it } from "vitest"
import {
  applyCodesearchLogContract,
  canonicalizeOtlpLogRecord,
} from "./logger.js"
import { otelResourceAttributes } from "./otel.js"

describe("codesearch log contract", () => {
  it("uses the same http and identity names as the backend", () => {
    const event: Record<string, unknown> = {
      method: "POST",
      path: "/search",
      status: 200,
      requestId: "req_cs",
      userId: "user_1",
      orgId: "org_1",
      environment: "pr-343",
      service: "codesearch",
      "service.namespace": "ctxpipe",
    }
    applyCodesearchLogContract(event)
    expect(event["http.request.method"]).toBe("POST")
    expect(event["url.path"]).toBe("/search")
    expect(event["http.response.status_code"]).toBe(200)
    expect(event["request.id"]).toBe("req_cs")
    expect(event["enduser.id"]).toBe("user_1")
    expect(event["ctxpipe.org.id"]).toBe("org_1")
    expect(event).not.toHaveProperty("method")
    expect(event).not.toHaveProperty("path")
    expect(event).not.toHaveProperty("environment")
    expect(event).not.toHaveProperty("service")
    expect(event).not.toHaveProperty("service.namespace")
  })

  it("drops environment and trace ids from the log body", () => {
    const event = {
      timestamp: new Date().toISOString(),
      level: "info" as const,
      service: "codesearch",
      environment: "production",
      traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
      spanId: "00f067aa0ba902b7",
      "request.id": "req_cs",
    }
    const record = canonicalizeOtlpLogRecord(toOTLPLogRecord(event))
    expect(record.traceId).toBe("4bf92f3577b34da6a3ce929d0e0e4736")
    const body = JSON.parse(record.body.stringValue) as Record<string, unknown>
    expect(body).not.toHaveProperty("environment")
    expect(body).not.toHaveProperty("service")
    expect(body).not.toHaveProperty("traceId")
    expect(otelResourceAttributes("codesearch", "production")).toEqual({
      "service.name": "codesearch",
      "service.namespace": "ctxpipe",
      "deployment.environment": "production",
    })
  })
})
