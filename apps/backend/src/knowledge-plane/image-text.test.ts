import { HttpResponse, http } from "msw"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { useMswServer } from "../../test/msw.js"
import {
  type ImageReading,
  imageText,
  readImage,
  renderMermaid,
  VisionError,
} from "./image-text.js"

const BASE = "https://openrouter.test/api/v1"
const server = useMswServer()

beforeEach(() => {
  vi.stubEnv("MODEL_PROVIDER", "openrouter")
  vi.stubEnv("MODEL_PROVIDER_API_KEY", "test-key")
  vi.stubEnv("MODEL_PROVIDER_URL", BASE)
})
afterEach(() => {
  vi.unstubAllEnvs()
})

const emptyDiagram: ImageReading["diagram"] = {
  kind: "none",
  direction: "TB",
  groups: [],
  nodes: [],
  edges: [],
  participants: [],
  messages: [],
}

const graphReading: ImageReading = {
  description: "A web service in a VPC.",
  text: "User\nAPI service\nPostgreSQL",
  diagram: {
    ...emptyDiagram,
    kind: "graph",
    direction: "LR",
    groups: [
      { id: "vpc", label: "VPC", parent: "" },
      { id: "priv", label: "Private subnet", parent: "vpc" },
    ],
    nodes: [
      { id: "u", label: "User", group: "" },
      { id: "api", label: 'API "v2"; main', group: "priv" },
      { id: "db", label: "PostgreSQL", group: "priv" },
    ],
    edges: [
      { from: "u", to: "api", label: "HTTPS", arrow: "forward" },
      { from: "api", to: "db", label: "", arrow: "both" },
      { from: "db", to: "vpc", label: "", arrow: "none" },
      { from: "api", to: "missing", label: "lost", arrow: "forward" },
    ],
  },
}

const sequenceReading: ImageReading = {
  description: "A login.",
  text: "",
  diagram: {
    ...emptyDiagram,
    kind: "sequence",
    participants: [
      { id: "b", label: "Browser" },
      { id: "s", label: "Server #1" },
    ],
    messages: [
      { from: "b", to: "s", label: "GET /login; then wait", reply: false },
      { from: "s", to: "b", label: "302", reply: true },
      { from: "s", to: "s", label: "log", reply: false },
    ],
  },
}

describe("renderMermaid", () => {
  it("renders a graph with nested groups, our own ids and escaped labels", () => {
    expect(renderMermaid(graphReading.diagram)).toBe(
      [
        "flowchart LR",
        '  n1["User"]',
        '  subgraph g1["VPC"]',
        '    subgraph g2["Private subnet"]',
        '      n2["API #quot;v2#quot;#59; main"]',
        '      n3["PostgreSQL"]',
        "    end",
        "  end",
        '  n1 -->|"HTTPS"| n2',
        "  n2 <--> n3",
        "  n3 --- g1",
      ].join("\n"),
    )
  })

  it("renders a sequence diagram with replies and self-messages", () => {
    expect(renderMermaid(sequenceReading.diagram)).toBe(
      [
        "sequenceDiagram",
        "  participant p1 as Browser",
        "  participant p2 as Server #35;1",
        "  p1->>p2: GET /login#59; then wait",
        "  p2-->>p1: 302",
        "  p2->>p2: log",
      ].join("\n"),
    )
  })

  it("gives no Mermaid for an image that is not a diagram", () => {
    expect(renderMermaid(emptyDiagram)).toBeNull()
  })

  it("puts a group with an unknown or cyclic parent at the top level", () => {
    const rendered = renderMermaid({
      ...emptyDiagram,
      kind: "graph",
      groups: [
        { id: "a", label: "A", parent: "b" },
        { id: "b", label: "B", parent: "a" },
        { id: "c", label: "C", parent: "nowhere" },
      ],
      nodes: [{ id: "x", label: "X", group: "a" }],
    })
    expect(rendered).toContain('subgraph g3["C"]')
    expect(
      rendered?.split("\n").filter((line) => line.includes("subgraph")),
    ).toHaveLength(3)
  })
})

describe("imageText", () => {
  it("joins the description, the text and the Mermaid", () => {
    expect(imageText(graphReading)).toBe(
      [
        "A web service in a VPC.",
        "",
        "Text in the image:",
        "User\nAPI service\nPostgreSQL",
        "",
        "```mermaid",
        renderMermaid(graphReading.diagram),
        "```",
        "",
      ].join("\n"),
    )
  })

  it("is the same for the same reading", () => {
    expect(imageText(sequenceReading)).toBe(imageText(sequenceReading))
  })
})

const completion = (reading: ImageReading, cost = 0.004) =>
  HttpResponse.json({
    provider: "Azure",
    choices: [{ message: { content: JSON.stringify(reading) } }],
    usage: { cost },
  })

describe("readImage", () => {
  const image = { bytes: Buffer.from("png-bytes"), mimeType: "image/png" }

  it("sends a ZDR request with no provider pin, and returns the reading and its cost", async () => {
    let body: Record<string, unknown> = {}
    server.use(
      http.post(`${BASE}/chat/completions`, async ({ request }) => {
        body = (await request.json()) as Record<string, unknown>
        expect(request.headers.get("authorization")).toBe("Bearer test-key")
        return completion(graphReading)
      }),
    )
    const result = await readImage(image, { model: "vendor/model-a" })
    expect(result).toMatchObject({
      reading: graphReading,
      costUsd: 0.004,
      provider: "Azure",
    })
    expect(body.model).toBe("vendor/model-a")
    expect(body.provider).toEqual({
      data_collection: "deny",
      zdr: true,
      require_parameters: true,
    })
    expect(JSON.stringify(body.messages)).toContain(
      `data:image/png;base64,${image.bytes.toString("base64")}`,
    )
    expect(body.response_format).toMatchObject({
      type: "json_schema",
      json_schema: { strict: true },
    })
  })

  it("retries a 5xx and a network error, then succeeds", async () => {
    let calls = 0
    server.use(
      http.post(`${BASE}/chat/completions`, () => {
        calls += 1
        if (calls === 1) return new HttpResponse(null, { status: 503 })
        if (calls === 2) return HttpResponse.error()
        return completion(sequenceReading)
      }),
    )
    const result = await readImage(image, {
      model: "vendor/model-a",
      backoffMs: 1,
    })
    expect(calls).toBe(3)
    expect(result.reading).toEqual(sequenceReading)
  })

  it("does not retry a 4xx, and keeps the body out of the error", async () => {
    let calls = 0
    server.use(
      http.post(`${BASE}/chat/completions`, () => {
        calls += 1
        return HttpResponse.json(
          { error: { message: "secret customer text" } },
          { status: 400 },
        )
      }),
    )
    const error = await readImage(image, {
      model: "vendor/model-a",
      backoffMs: 1,
    }).catch((caught: unknown) => caught)
    expect(calls).toBe(1)
    expect(error).toBeInstanceOf(VisionError)
    expect(error).toMatchObject({ kind: "http", status: 400 })
    expect(String((error as Error).message)).not.toContain("secret")
  })

  it("fails an answer out of the schema as invalid-answer", async () => {
    server.use(
      http.post(`${BASE}/chat/completions`, () =>
        HttpResponse.json({
          choices: [{ message: { content: '{"description": 3}' } }],
        }),
      ),
    )
    await expect(
      readImage(image, { model: "vendor/model-a" }),
    ).rejects.toMatchObject({ kind: "invalid-answer" })
  })

  it("refuses a deployment whose model provider is not OpenRouter", async () => {
    vi.stubEnv("MODEL_PROVIDER", "bedrock")
    await expect(
      readImage(image, { model: "vendor/model-a" }),
    ).rejects.toMatchObject({ kind: "config" })
  })
})
