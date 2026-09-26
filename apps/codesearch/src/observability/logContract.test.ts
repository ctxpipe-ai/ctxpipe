import { initLogger, log } from "evlog"
import { describe, expect, it } from "vitest"
import { applyCodesearchLogContract, codesearchLogRedact } from "./logger.js"

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
    expect(event.environment).toBe("pr-343")
    expect(event.service).toBe("codesearch")
    expect(event["service.namespace"]).toBe("ctxpipe")
    expect(event).not.toHaveProperty("method")
    expect(event).not.toHaveProperty("path")
  })

  it("keeps a downstream status off the access-log key", () => {
    const downstream: Record<string, unknown> = {
      step: "codesearch.search.zoekt_rejected",
      status: 422,
      "upstream.status_code": 422,
    }
    applyCodesearchLogContract(downstream)
    expect(downstream.status).toBe(422)
    expect(downstream["upstream.status_code"]).toBe(422)
    expect(downstream).not.toHaveProperty("http.response.status_code")
  })

  it("redacts pg error fields and drizzle params", () => {
    const events: Record<string, unknown>[] = []
    initLogger({
      env: { service: "codesearch", environment: "test" },
      pretty: false,
      silent: true,
      redact: codesearchLogRedact,
      drain: (ctx) => {
        const batch = Array.isArray(ctx) ? ctx : [ctx]
        for (const item of batch) {
          events.push(item.event as Record<string, unknown>)
        }
      },
    })
    log.error({
      error: {
        message:
          'Failed query: insert into "repositories" ("git_url") values ($1)\nparams: https://github.com/octocat/Spoon-Knife.git',
        detail: "Key (git_url)=(https://github.com/octocat/Spoon-Knife.git)",
        where: "somewhere secret",
        hint: "Use the existing row",
        internalQuery: "insert into repositories values ('secret')",
        code: "23505",
      },
    })
    expect(events).toHaveLength(1)
    const error = events[0]?.error as Record<string, unknown>
    expect(error.code).toBe("23505")
    expect(error.detail).toBe("[REDACTED]")
    expect(error.where).toBe("[REDACTED]")
    expect(error.hint).toBe("[REDACTED]")
    expect(error.internalQuery).toBe("[REDACTED]")
    expect(JSON.stringify(events)).not.toContain("Spoon-Knife")
    expect(JSON.stringify(events)).not.toContain("params:")
  })
})
