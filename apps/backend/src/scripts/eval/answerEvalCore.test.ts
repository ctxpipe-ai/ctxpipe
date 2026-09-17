import { describe, expect, it } from "vitest"
import {
  callCtxAdvisor,
  type EvalQuestion,
  type EvalResult,
  extractToolText,
  type FetchLike,
  gradeHeuristically,
  parseMcpBody,
  renderReport,
} from "./answerEvalCore.js"

describe("parseMcpBody", () => {
  it("accepts a plain JSON-RPC body", () => {
    expect(
      parseMcpBody('{"jsonrpc":"2.0","id":"call","result":{"content":[]}}'),
    ).toEqual([{ jsonrpc: "2.0", id: "call", result: { content: [] } }])
  })

  it("accepts an SSE body and ignores non-data lines", () => {
    const body = [
      "event: message",
      'data: {"jsonrpc":"2.0","method":"notifications/progress"}',
      "",
      'data: {"jsonrpc":"2.0","id":"call","result":{"content":[{"type":"text","text":"hi"}]}}',
      "",
    ].join("\n")
    expect(parseMcpBody(body)).toHaveLength(2)
  })
})

describe("extractToolText", () => {
  it("joins text parts of the first result and surfaces tool errors", () => {
    expect(
      extractToolText([
        { jsonrpc: "2.0", method: "notifications/progress" },
        {
          jsonrpc: "2.0",
          id: "call",
          result: {
            content: [
              { type: "text", text: "a" },
              { type: "image" },
              { type: "text", text: "b" },
            ],
          },
        },
      ]),
    ).toBe("a\nb")
    expect(() =>
      extractToolText([
        { jsonrpc: "2.0", id: "call", error: { message: "boom" } },
      ]),
    ).toThrow(/boom/)
    expect(() => extractToolText([])).toThrow(/no text/)
  })
})

describe("gradeHeuristically", () => {
  const question: EvalQuestion = {
    id: "why-1",
    category: "why",
    question: "Why?",
    expectedKinds: ["PullRequest", "Issue", "Decision"],
  }

  it("counts citations, resolvable citations and expected kinds reached", () => {
    const answer =
      "See https://github.com/acme/api/pull/42 (ADR-7) and ENG-123 at https://linear.app/acme/issue/ENG-123/x. Owned by the backend team."
    const grade = gradeHeuristically(question, answer, {
      "https://github.com/acme/api/pull/42": true,
      "https://linear.app/acme/issue/ENG-123/x": false,
    })
    expect(grade.citations).toBe(2)
    expect(grade.groundedUrls).toBe(1)
    expect(grade.kindsHit.sort()).toEqual(["Decision", "Issue", "PullRequest"])
  })

  it("does not credit kinds the question did not ask for", () => {
    const grade = gradeHeuristically(
      { ...question, expectedKinds: ["Team"] },
      "https://github.com/acme/api/pull/42 is owned by the platform team.",
      {},
    )
    expect(grade.kindsHit).toEqual(["Team"])
  })
})

describe("renderReport", () => {
  it("aggregates per target and lists every question", () => {
    const question: EvalQuestion = {
      id: "q1",
      category: "why",
      question: "Why?",
    }
    const results: EvalResult[] = [
      {
        target: "prod",
        question,
        answer: "old",
        ms: 100,
        grade: { citations: 0, groundedUrls: 0, kindsHit: [] },
      },
      {
        target: "preview",
        question,
        answer: "new https://github.com/a/b/pull/1",
        ms: 300,
        grade: {
          citations: 1,
          groundedUrls: 1,
          kindsHit: ["PullRequest"],
          judge: { correct: 2, grounded: 2, fakeStandard: false, notes: "" },
        },
      },
      {
        target: "preview",
        question: { ...question, id: "q2" },
        answer: "",
        ms: 5,
        grade: { citations: 0, groundedUrls: 0, kindsHit: [] },
        error: "HTTP 500",
      },
    ]
    const report = renderReport(results, [
      { name: "prod" },
      { name: "preview" },
    ])
    expect(report).toContain("## prod")
    expect(report).toContain("- answered: 1, errors: 0")
    expect(report).toContain("## preview")
    expect(report).toContain("- answered: 1, errors: 1")
    expect(report).toContain("- judge correctness (0-2): 2.00")
    expect(report).toContain("| q2 | why | preview |")
    expect(report).toContain("HTTP 500")
  })
})

describe("callCtxAdvisor", () => {
  it("performs initialize, initialized, tools/call and forwards the session header", async () => {
    const calls: Array<{
      body: Record<string, unknown>
      headers: Record<string, string>
    }> = []
    const fakeFetch: FetchLike = async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>
      const headers = init?.headers as Record<string, string>
      calls.push({ body, headers })
      if (body.method === "initialize") {
        return new Response(
          JSON.stringify({ jsonrpc: "2.0", id: "init", result: {} }),
          {
            status: 200,
            headers: { "mcp-session-id": "sess-1" },
          },
        )
      }
      if (body.method === "notifications/initialized")
        return new Response(null, { status: 202 })
      return new Response(
        `event: message\ndata: ${JSON.stringify({
          jsonrpc: "2.0",
          id: "call",
          result: { content: [{ type: "text", text: "answer" }] },
        })}\n\n`,
        { status: 200, headers: { "content-type": "text/event-stream" } },
      )
    }

    const text = await callCtxAdvisor(
      { name: "preview", url: "https://preview.example/mcp?orgSlug=acme" },
      "key-123",
      "Why?",
      fakeFetch,
    )

    expect(text).toBe("answer")
    expect(calls.map((c) => c.body.method)).toEqual([
      "initialize",
      "notifications/initialized",
      "tools/call",
    ])
    expect(calls[0]?.headers["x-api-key"]).toBe("key-123")
    expect(calls[0]?.headers["mcp-session-id"]).toBeUndefined()
    expect(calls[2]?.headers["mcp-session-id"]).toBe("sess-1")
    expect(calls[2]?.body.params).toEqual({
      name: "ctx_advisor",
      arguments: { prompt: "Why?" },
    })
  })

  it("fails loudly on a non-2xx initialize", async () => {
    const fakeFetch: FetchLike = async () =>
      new Response("nope", { status: 401 })
    await expect(
      callCtxAdvisor(
        { name: "prod", url: "https://x/mcp" },
        "k",
        "q",
        fakeFetch,
      ),
    ).rejects.toThrow(/initialize failed: HTTP 401/)
  })
})
