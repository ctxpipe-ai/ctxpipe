import { describe, expect, it } from "vitest"

import { parseEnv } from "./env.js"

const base = {
  NODE_ENV: "test",
  DATABASE_URL: "postgres://localhost:5432/ctxpipe",
  AUTH_SECRET: "abcdefghijklmnopqrstuvwxyz123456",
}

describe("parseEnv MODEL_VISION_NAME", () => {
  it("gives the default vision model when the variable is unset or empty", () => {
    expect(parseEnv(base).MODEL_VISION_NAME).toBe("openai/gpt-6.1-terra")
    expect(parseEnv({ ...base, MODEL_VISION_NAME: "" }).MODEL_VISION_NAME).toBe(
      "openai/gpt-6.1-terra",
    )
  })

  it("gives the model of the variable, trimmed", () => {
    expect(
      parseEnv({ ...base, MODEL_VISION_NAME: " vendor/custom " })
        .MODEL_VISION_NAME,
    ).toBe("vendor/custom")
  })

  it("refuses a value of only spaces", () => {
    expect(() => parseEnv({ ...base, MODEL_VISION_NAME: "   " })).toThrow(
      "MODEL_VISION_NAME must name one OpenRouter model",
    )
  })
})
