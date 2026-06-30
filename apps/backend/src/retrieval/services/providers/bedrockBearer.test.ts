import type { Mock } from "vitest"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const mockProvideToken = vi.hoisted(() => vi.fn(async () => "mock-bedrock-bearer"))
const getTokenProvider = vi.hoisted(() => vi.fn(() => mockProvideToken))

vi.mock("@aws/bedrock-token-generator", () => ({
  getTokenProvider,
}))

describe("bedrockBearer", () => {
  beforeEach(() => {
    getTokenProvider.mockClear()
    mockProvideToken.mockClear()
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("ok")))
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  describe("resolveBedrockRegion", () => {
    it("prefers MODEL_BEDROCK_AWS_REGION over other sources", async () => {
      const { resolveBedrockRegion } = await import("./bedrockBearer.js")
      expect(
        resolveBedrockRegion({
          MODEL_BEDROCK_AWS_REGION: "eu-west-1",
          AWS_REGION: "us-east-1",
          AWS_DEFAULT_REGION: "us-west-2",
          MODEL_PROVIDER_URL: "https://bedrock-mantle.ap-southeast-1.api.aws/v1",
        }),
      ).toBe("eu-west-1")
    })

    it("falls back to AWS_REGION then AWS_DEFAULT_REGION", async () => {
      const { resolveBedrockRegion } = await import("./bedrockBearer.js")
      expect(resolveBedrockRegion({ AWS_REGION: "us-west-2" })).toBe("us-west-2")
      expect(resolveBedrockRegion({ AWS_DEFAULT_REGION: "ca-central-1" })).toBe(
        "ca-central-1",
      )
    })

    it("parses region from bedrock-mantle host", async () => {
      const { resolveBedrockRegion } = await import("./bedrockBearer.js")
      expect(
        resolveBedrockRegion(
          {},
          "https://bedrock-mantle.us-east-1.api.aws/v1/chat/completions",
        ),
      ).toBe("us-east-1")
    })

    it("parses region from bedrock-runtime host", async () => {
      const { resolveBedrockRegion } = await import("./bedrockBearer.js")
      expect(
        resolveBedrockRegion(
          {},
          "https://bedrock-runtime.eu-north-1.amazonaws.com/openai/v1",
        ),
      ).toBe("eu-north-1")
    })

    it("uses MODEL_PROVIDER_URL when no explicit region env is set", async () => {
      const { resolveBedrockRegion } = await import("./bedrockBearer.js")
      expect(
        resolveBedrockRegion({
          MODEL_PROVIDER_URL: "https://bedrock-mantle.ap-northeast-1.api.aws/v1",
        }),
      ).toBe("ap-northeast-1")
    })

    it("returns undefined when region cannot be resolved", async () => {
      const { resolveBedrockRegion } = await import("./bedrockBearer.js")
      expect(resolveBedrockRegion({})).toBeUndefined()
      expect(
        resolveBedrockRegion({ MODEL_PROVIDER_URL: "https://api.openai.com/v1" }),
      ).toBeUndefined()
    })
  })

  describe("createBedrockBearerFetch", () => {
    it("obtains a token and sets Authorization on outbound requests", async () => {
      const { createBedrockBearerFetch } = await import("./bedrockBearer.js")
      const fetchFn = createBedrockBearerFetch("us-east-1")

      expect(getTokenProvider).toHaveBeenCalledWith({ region: "us-east-1" })

      await fetchFn("https://bedrock-mantle.us-east-1.api.aws/v1/chat/completions", {
        method: "POST",
      })

      expect(mockProvideToken).toHaveBeenCalled()
      const fetchMock = globalThis.fetch as unknown as Mock
      const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]
      expect((init.headers as Headers).get("Authorization")).toBe(
        "Bearer mock-bedrock-bearer",
      )
    })
  })

  describe("getBedrockBearerToken", () => {
    it("returns the token from getTokenProvider", async () => {
      const { getBedrockBearerToken } = await import("./bedrockBearer.js")
      await expect(getBedrockBearerToken("ap-south-1")).resolves.toBe(
        "mock-bedrock-bearer",
      )
      expect(getTokenProvider).toHaveBeenCalledWith({ region: "ap-south-1" })
    })
  })
})
