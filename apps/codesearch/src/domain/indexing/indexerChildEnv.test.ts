import { afterEach, describe, expect, it } from "vitest"
import { withIndexerGoLimits } from "./indexerChildEnv.js"

const envKeysTouchedByTests = [
  "GOMAXPROCS",
  "GOGC",
  "PATH",
  "HOME",
  "USER",
  "TMPDIR",
  "JAVA_HOME",
  "DOTNET_ROOT",
  "PUB_CACHE",
  "CARGO_HOME",
  "NUGET_PACKAGES",
  "GOPATH",
  "GOMODCACHE",
  "GOCACHE",
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

  it("keeps allowlisted toolchain, HOME, and cache roots", () => {
    process.env.PATH = "/usr/local/bin:/usr/bin"
    process.env.HOME = "/home/indexer"
    process.env.TMPDIR = "/tmp/indexer"
    process.env.JAVA_HOME = "/usr/lib/jvm/java-17-openjdk-amd64"
    process.env.DOTNET_ROOT = "/usr/share/dotnet"
    process.env.PUB_CACHE = "/opt/pub-cache"
    process.env.CARGO_HOME = "/usr/local/cargo"
    process.env.NUGET_PACKAGES = "/opt/nuget"
    process.env.GOPATH = "/explicit/gopath"
    process.env.GOMODCACHE = "/explicit/gomodcache"

    const env = withIndexerGoLimits({
      JAVA_HOME: "/custom/jdk",
      PUB_CACHE: undefined,
      GOMAXPROCS: "4",
      GOGC: "75",
    })

    expect(env.PATH).toBe("/usr/local/bin:/usr/bin")
    expect(env.HOME).toBe("/home/indexer")
    expect(env.TMPDIR).toBe("/tmp/indexer")
    expect(env.JAVA_HOME).toBe("/custom/jdk")
    expect(env.DOTNET_ROOT).toBe("/usr/share/dotnet")
    expect(env.CARGO_HOME).toBe("/usr/local/cargo")
    expect(env.NUGET_PACKAGES).toBe("/opt/nuget")
    expect(env.PUB_CACHE).toBeUndefined()
    expect(env.GOPATH).toBe("/explicit/gopath")
    expect(env.GOMODCACHE).toBe("/explicit/gomodcache")
    expect(env.GOMAXPROCS).toBe("4")
    expect(env.GOGC).toBe("75")
  })

  it("derives Go cache defaults from HOME when GOPATH/GOMODCACHE are unset", () => {
    delete process.env.GOPATH
    delete process.env.GOMODCACHE
    delete process.env.GOCACHE
    process.env.HOME = "/home/indexer"

    const env = withIndexerGoLimits()
    expect(env.HOME).toBe("/home/indexer")
    expect(env.GOPATH).toBe("/home/indexer/go")
    expect(env.GOMODCACHE).toBe("/home/indexer/go/pkg/mod")
    expect(env.GOCACHE).toBe("/home/indexer/.cache/go-build")
  })

  it("uses /tmp/ctxpipe-go when HOME and Go cache vars are unset", () => {
    delete process.env.HOME
    delete process.env.GOPATH
    delete process.env.GOMODCACHE
    delete process.env.GOCACHE

    const env = withIndexerGoLimits()
    expect(env.GOPATH).toBe("/tmp/ctxpipe-go")
    expect(env.GOMODCACHE).toBe("/tmp/ctxpipe-go/pkg/mod")
    expect(env.GOCACHE).toBe("/tmp/ctxpipe-go/cache")
  })

  it("does not leak service secrets from ambient env or caller spreads", () => {
    process.env.PATH = "/safe/bin"
    process.env.HOME = "/home/indexer"
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
    expect(env.HOME).toBe("/home/indexer")
    expect(env.GOMAXPROCS).toBe("4")
    expect(env.GOGC).toBe("50")
    expect(env.GOPATH).toBeTruthy()
    expect(env.GOMODCACHE).toBeTruthy()
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
