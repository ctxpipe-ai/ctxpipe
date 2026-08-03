import { afterEach, describe, expect, it } from "vitest"
import { withIndexerGoLimits } from "./indexerChildEnv.js"

const envKeysTouchedByTests = [
  "GOMAXPROCS",
  "GOGC",
  "PATH",
  "JAVA_HOME",
  "DOTNET_ROOT",
  "PUB_CACHE",
  "DATABASE_URL",
  "AUTH_SECRET",
  "JWT_SECRET",
  "OTEL_EXPORTER_OTLP_HEADERS",
  "LANGFUSE_SECRET_KEY",
  "OPENAI_API_KEY",
  "UNRELATED_FLAG",
] as const

const originalEnv = new Map(
  envKeysTouchedByTests.map((key) => [key, process.env[key]]),
)

afterEach(() => {
  for (const key of envKeysTouchedByTests) {
    const originalValue = originalEnv.get(key)
    if (originalValue === undefined) delete process.env[key]
    else process.env[key] = originalValue
  }
})

describe("withIndexerGoLimits", () => {
  it("defaults GOMAXPROCS=2 and GOGC=50 when unset", () => {
    delete process.env.GOMAXPROCS
    delete process.env.GOGC
    const env = withIndexerGoLimits()
    expect(env.GOMAXPROCS).toBe("2")
    expect(env.GOGC).toBe("50")
  })

  it("does not override explicit caller or process values", () => {
    process.env.GOMAXPROCS = "8"
    process.env.GOGC = "100"
    expect(withIndexerGoLimits().GOMAXPROCS).toBe("8")
    expect(withIndexerGoLimits({ GOMAXPROCS: "4" }).GOMAXPROCS).toBe("4")
    expect(withIndexerGoLimits({ GOGC: "25" }).GOGC).toBe("25")
  })

  it("keeps only allowlisted toolchain env and explicit indexer limits", () => {
    process.env.PATH = "/usr/local/bin:/usr/bin"
    process.env.JAVA_HOME = "/usr/lib/jvm/java-17-openjdk-amd64"
    process.env.DOTNET_ROOT = "/usr/share/dotnet"
    process.env.PUB_CACHE = "/opt/pub-cache"

    const env = withIndexerGoLimits({
      JAVA_HOME: "/custom/jdk",
      PUB_CACHE: undefined,
      GOMAXPROCS: "4",
      GOGC: "75",
    })

    expect(env.PATH).toBe("/usr/local/bin:/usr/bin")
    expect(env.JAVA_HOME).toBe("/custom/jdk")
    expect(env.DOTNET_ROOT).toBe("/usr/share/dotnet")
    expect(env.PUB_CACHE).toBeUndefined()
    expect(env.GOMAXPROCS).toBe("4")
    expect(env.GOGC).toBe("75")
  })

  it("does not leak service secrets from ambient env or caller spreads", () => {
    process.env.PATH = "/safe/bin"
    process.env.DATABASE_URL = "postgres://service:secret@localhost/ctxpipe"
    process.env.AUTH_SECRET = "a".repeat(32)
    process.env.JWT_SECRET = "jwt-secret"
    process.env.OTEL_EXPORTER_OTLP_HEADERS = "authorization=Bearer telemetry"
    process.env.LANGFUSE_SECRET_KEY = "lf-secret"
    process.env.OPENAI_API_KEY = "sk-secret"
    process.env.UNRELATED_FLAG = "should-not-pass"

    const env = withIndexerGoLimits({
      ...process.env,
      PATH: "/child/bin",
      DATABASE_URL: "postgres://caller:secret@localhost/ctxpipe",
      AUTH_SECRET: "b".repeat(32),
      JWT_SECRET: "caller-jwt-secret",
      OPENAI_API_KEY: "caller-sk-secret",
      UNRELATED_FLAG: "caller-flag",
      GOMAXPROCS: "4",
    })

    expect(env.PATH).toBe("/child/bin")
    expect(env.GOMAXPROCS).toBe("4")
    expect(env.GOGC).toBe("50")
    for (const key of [
      "DATABASE_URL",
      "AUTH_SECRET",
      "JWT_SECRET",
      "OTEL_EXPORTER_OTLP_HEADERS",
      "LANGFUSE_SECRET_KEY",
      "OPENAI_API_KEY",
      "UNRELATED_FLAG",
    ]) {
      expect(env[key]).toBeUndefined()
    }
  })
})
