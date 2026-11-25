import { chat } from "@tanstack/ai"
import { HttpResponse, http } from "msw"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { useMswServer } from "../../../test/msw.js"
import { parseEnv } from "../../config/env.js"
import { readImage } from "../../knowledge-plane/image-text.js"
import { embedQuery } from "../embeddings/textEmbeddings.js"
import { decideNoul } from "../jev/client.js"
import { generateEmbeddings, getModel } from "./modelProvider.js"
import {
  isOpenRouterCall,
  openRouterProvider,
  providerAllowlist,
  withOpenRouterProvider,
  withProviderBlock,
} from "./openRouterProvider.js"

const OPENROUTER = "https://openrouter.ai/api/v1"
const ALLOWLIST = "openai,azure,google-vertex"
const BLOCK = {
  data_collection: "deny",
  zdr: true,
  only: ["openai", "azure", "google-vertex"],
}

afterEach(() => vi.unstubAllEnvs())

describe("providerAllowlist", () => {
  it("is undefined when the setting is unset, empty or only spaces", () => {
    expect(providerAllowlist(undefined)).toBeUndefined()
    expect(providerAllowlist("")).toBeUndefined()
    expect(providerAllowlist("  ")).toBeUndefined()
  })

  it("reads OpenRouter provider slugs separated by commas", () => {
    expect(
      providerAllowlist(
        " openai, anthropic ,azure,amazon-bedrock,google-vertex,google-ai-studio,typesafe",
      ),
    ).toEqual([
      "openai",
      "anthropic",
      "azure",
      "amazon-bedrock",
      "google-vertex",
      "google-ai-studio",
      "typesafe",
    ])
  })

  it("refuses a value that is not a list of base slugs, so a typing error does not remove the filter", () => {
    expect(() => providerAllowlist("OpenAI; Anthropic")).toThrow(
      /MODEL_PROVIDER_ALLOWLIST/,
    )
    expect(() => providerAllowlist("google-vertex/global")).toThrow(
      /MODEL_PROVIDER_ALLOWLIST/,
    )
    // A value of only commas, or with an empty entry, is no list either.
    for (const value of [",", " , ", "openai,,azure", "openai,"])
      expect(() => providerAllowlist(value)).toThrow(/MODEL_PROVIDER_ALLOWLIST/)
  })

  it("stops the backend at start on a bad value", () => {
    const env = {
      NODE_ENV: "test",
      DATABASE_URL: "postgres://localhost:5432/fixture",
      GRAPH_DB_URI: "redis://localhost:6379",
      AUTH_BASE_URL: "https://backend.example.com",
      AUTH_SECRET: "fixture-provider-allowlist-secret-32-chars",
    }
    expect(() =>
      parseEnv({ ...env, MODEL_PROVIDER_ALLOWLIST: "Open AI" }),
    ).toThrow(/MODEL_PROVIDER_ALLOWLIST/)
    expect(
      parseEnv({ ...env, MODEL_PROVIDER_ALLOWLIST: ALLOWLIST })
        .MODEL_PROVIDER_ALLOWLIST,
    ).toBe(ALLOWLIST)
  })

  it("stops the backend at start when the model settings do not send each call to OpenRouter", () => {
    const env = {
      NODE_ENV: "test",
      DATABASE_URL: "postgres://localhost:5432/fixture",
      GRAPH_DB_URI: "redis://localhost:6379",
      AUTH_BASE_URL: "https://backend.example.com",
      AUTH_SECRET: "fixture-provider-allowlist-secret-32-chars",
      MODEL_PROVIDER_ALLOWLIST: ALLOWLIST,
    }
    // A gateway in front of OpenRouter must say so with the openrouter kind,
    // else its tier calls would leave the allowlist.
    expect(() =>
      parseEnv({
        ...env,
        MODEL_PROVIDER: "openai-like",
        MODEL_PROVIDER_URL: "https://gateway.example.com/v1",
      }),
    ).toThrow(/needs model settings that point at OpenRouter/)
    expect(() => parseEnv({ ...env, MODEL_PROVIDER: "bedrock" })).toThrow(
      /needs model settings that point at OpenRouter/,
    )
    expect(() =>
      parseEnv({
        ...env,
        MODEL_PROVIDER: "openrouter",
        MODEL_PROVIDER_URL: "https://gateway.example.com/v1",
      }),
    ).not.toThrow()
    expect(() => parseEnv(env)).not.toThrow()
  })
})

describe("openRouterProvider", () => {
  it("is ZDR with no data collection, and no provider filter without an allowlist", () => {
    expect(openRouterProvider()).toEqual({ data_collection: "deny", zdr: true })
  })

  it("allows only the providers of the allowlist, with no pin and no order", () => {
    vi.stubEnv("MODEL_PROVIDER_ALLOWLIST", ALLOWLIST)
    expect(openRouterProvider()).toEqual(BLOCK)
  })
})

describe("withOpenRouterProvider", () => {
  beforeEach(() => vi.stubEnv("MODEL_PROVIDER_ALLOWLIST", ALLOWLIST))

  it("puts the block over the provider fields of a request, and keeps its other fields", () => {
    expect(
      withOpenRouterProvider({
        model: "m",
        provider: {
          zdr: false,
          data_collection: "allow",
          only: ["deepinfra"],
          sort: "latency",
        },
      }),
    ).toEqual({ model: "m", provider: { ...BLOCK, sort: "latency" } })
  })

  it("keeps an only list that narrows the allowlist, also with an endpoint tag", () => {
    expect(
      withOpenRouterProvider({
        provider: { only: ["azure", "google-vertex/global"] },
      }).provider,
    ).toEqual({ ...BLOCK, only: ["azure", "google-vertex/global"] })
  })

  it("replaces an only list with one provider outside the allowlist", () => {
    expect(
      withOpenRouterProvider({ provider: { only: ["azure", "nebius/bf16"] } })
        .provider,
    ).toEqual(BLOCK)
  })

  it("adds the block to a request with no provider fields", () => {
    expect(withOpenRouterProvider({ model: "m" })).toEqual({
      model: "m",
      provider: BLOCK,
    })
  })
})

describe("withProviderBlock", () => {
  it("puts the block on a JSON object to OpenRouter, and leaves other bodies as they are", () => {
    expect(withProviderBlock("openrouter", undefined, { model: "m" })).toEqual({
      model: "m",
      provider: { data_collection: "deny", zdr: true },
    })
    expect(withProviderBlock("openrouter", undefined, ["m"])).toEqual(["m"])
    expect(
      withProviderBlock("openai-like", "https://api.openai.com/v1", {
        model: "m",
      }),
    ).toEqual({ model: "m" })
  })
})

describe("isOpenRouterCall", () => {
  it("is true for the openrouter kind and for the OpenRouter host", () => {
    expect(isOpenRouterCall("openrouter", "https://proxy.test/v1")).toBe(true)
    expect(isOpenRouterCall("openai-like", undefined)).toBe(true)
    expect(isOpenRouterCall(undefined, `${OPENROUTER}/`)).toBe(true)
  })

  it("is false for another OpenAI-compatible API, Azure and Bedrock", () => {
    expect(isOpenRouterCall("openai-like", "https://api.openai.com/v1")).toBe(
      false,
    )
    expect(isOpenRouterCall("azure", OPENROUTER)).toBe(false)
    expect(isOpenRouterCall("bedrock", undefined)).toBe(false)
  })
})

/*
 * Each model client of the backend that sends to OpenRouter sends the block.
 * A new client that bypasses it must get a case here (ADR-070). The two
 * proxy routes have their cases in `routes/v1/openai.test.ts` and
 * `workspace-chat-openai.integration.test.ts`, the eval recorder and the
 * judge panel in `knowledge-reader/knowledge-eval.test.ts`.
 */
describe("each model client sends the provider block", () => {
  const server = useMswServer()
  const bodies: Record<string, unknown>[] = []
  const answer = (path: string, reply: Record<string, unknown>) =>
    http.post(`${OPENROUTER}${path}`, async ({ request }) => {
      bodies.push((await request.json()) as Record<string, unknown>)
      return HttpResponse.json(reply)
    })
  const completion = (content: string) => ({
    id: "reply",
    model: "m",
    provider: "Azure",
    choices: [
      {
        index: 0,
        message: { role: "assistant", content },
        finish_reason: "stop",
      },
    ],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  })

  beforeEach(() => {
    bodies.length = 0
    vi.stubEnv("MODEL_PROVIDER_ALLOWLIST", ALLOWLIST)
    vi.stubEnv("MODEL_PROVIDER", "openrouter")
    vi.stubEnv("MODEL_PROVIDER_API_KEY", "fixture-key")
    vi.stubEnv("MODEL_PROVIDER_URL", "")
    vi.stubEnv("MODEL_FAST_NAME", "vendor/fast")
  })

  it.each(["openrouter", "openai-like"])(
    "a tier call with %s settings",
    async (kind) => {
      vi.stubEnv("MODEL_PROVIDER", kind)
      server.use(answer("/chat/completions", completion("ok")))
      await chat({
        adapter: getModel("fast"),
        messages: [{ role: "user", content: "hi" }],
        stream: false,
      })
      expect(bodies[0]?.provider).toEqual(BLOCK)
    },
  )

  it("a tier call keeps the provider fields of its model spec under the block", async () => {
    vi.stubEnv(
      "MODEL_FAST_NAME",
      "vendor/fast?openrouter.provider.sort=latency&openrouter.provider.zdr=false",
    )
    server.use(answer("/chat/completions", completion("ok")))
    await chat({
      adapter: getModel("fast"),
      messages: [{ role: "user", content: "hi" }],
      stream: false,
    })
    expect(bodies[0]?.provider).toEqual({ ...BLOCK, sort: "latency" })
  })

  it("a tier call to another OpenAI-compatible API sends no provider field", async () => {
    vi.stubEnv("MODEL_PROVIDER", "openai-like")
    vi.stubEnv("MODEL_PROVIDER_URL", "https://api.openai.test/v1")
    server.use(
      http.post(
        "https://api.openai.test/v1/chat/completions",
        async ({ request }) => {
          bodies.push((await request.json()) as Record<string, unknown>)
          return HttpResponse.json(completion("ok"))
        },
      ),
    )
    await chat({
      adapter: getModel("fast"),
      messages: [{ role: "user", content: "hi" }],
      stream: false,
    })
    expect(bodies[0]).not.toHaveProperty("provider")
  })

  it("the embeddings of the current stack", async () => {
    server.use(
      answer("/embeddings", {
        data: [{ index: 0, embedding: Array(2000).fill(0.1) }],
      }),
    )
    await generateEmbeddings(["hi"])
    expect(bodies[0]?.provider).toEqual(BLOCK)
  })

  it("the embeddings of the knowledge plane", async () => {
    server.use(
      answer("/embeddings", {
        data: [{ index: 0, embedding: Array(1024).fill(0.1) }],
      }),
    )
    await embedQuery("hi")
    expect(bodies[0]?.provider).toMatchObject(BLOCK)
  })

  it("Jev", async () => {
    server.use(
      http.post(
        "https://openrouter.ai/api/alpha/decisions",
        async ({ request }) => {
          bodies.push((await request.json()) as Record<string, unknown>)
          return HttpResponse.json({
            answers: { sky: { type: "noul", noul: 0.9 } },
          })
        },
      ),
    )
    await decideNoul(
      ["The sky is blue."],
      { sky: { type: "noul", instructions: "Is the sky blue?" } },
      { timeoutMs: 5_000, attributes: {} },
    )
    expect(bodies[0]?.provider).toEqual(BLOCK)
  })

  it("the vision model", async () => {
    server.use(
      answer(
        "/chat/completions",
        completion(
          JSON.stringify({
            kind: "other",
            text: "A box.",
            nodes: [],
            edges: [],
          }),
        ),
      ),
    )
    await readImage(
      { bytes: Buffer.from("png-bytes"), mimeType: "image/png" },
      { model: "vendor/vision" },
    ).catch(() => undefined)
    expect(bodies[0]?.provider).toEqual({ ...BLOCK, require_parameters: true })
  })
})
