import { HttpResponse, http } from "msw"
import { setupServer } from "msw/node"
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest"
import {
  getHyperDxRuntimeConfig,
  readHyperDxDocumentIdentity,
} from "./hyperdxRuntimeConfig"

const server = setupServer()

beforeAll(() => {
  server.listen({ onUnhandledRequest: "error" })
})

afterEach(() => {
  server.resetHandlers()
  vi.unstubAllEnvs()
})

afterAll(() => {
  server.close()
})

function documentRequest(pathname: string, cookie?: string): Request {
  const headers = new Headers({
    "x-forwarded-host": "app.example",
    "x-forwarded-proto": "https",
  })
  if (cookie) headers.set("cookie", cookie)
  return new Request(`http://ui.internal${pathname}`, { headers })
}

function sessionHandlers(activeOrganizationId = "org_1") {
  return [
    http.get(
      "https://app.example/.auth/api/v1/auth/get-session",
      ({ request }) => {
        expect(request.headers.get("cookie")).toBe("session=abc")
        return HttpResponse.json({
          user: { id: "user_1", email: "a@b.c", name: "Ada" },
          session: { activeOrganizationId },
        })
      },
    ),
    http.get("https://app.example/.auth/api/v1/auth/organization/list", () =>
      HttpResponse.json([
        { id: "org_1", slug: "acme", name: "Acme Inc" },
        { id: "org_2", slug: "beta", name: "Beta" },
      ]),
    ),
  ]
}

describe("getHyperDxRuntimeConfig", () => {
  it("is disabled when no traces endpoint is set", () => {
    vi.stubEnv("OTEL_EXPORTER_OTLP_TRACES_ENDPOINT", "")
    expect(getHyperDxRuntimeConfig()).toEqual({ enabled: false })
  })

  it("is enabled when the traces endpoint is set", () => {
    vi.stubEnv(
      "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT",
      "http://collector:4318/v1/traces",
    )
    expect(getHyperDxRuntimeConfig()).toEqual({ enabled: true })
  })
})

describe("readHyperDxDocumentIdentity", () => {
  it("stamps the org in the URL from the same record and drops email", async () => {
    server.use(...sessionHandlers())
    const identity = await readHyperDxDocumentIdentity(
      documentRequest("/acme/repositories", "session=abc"),
      "/acme/repositories",
    )
    expect(identity).toEqual({
      userId: "user_1",
      teamId: "org_1",
      teamName: "acme",
    })
    expect(JSON.stringify(identity)).not.toContain("a@b.c")
    expect(JSON.stringify(identity)).not.toContain("Ada")
  })

  it("reads identity even when the request looks like a client fetch", async () => {
    server.use(...sessionHandlers())
    const request = documentRequest("/acme/repositories", "session=abc")
    request.headers.set("sec-fetch-dest", "empty")
    await expect(
      readHyperDxDocumentIdentity(request, "/acme/repositories"),
    ).resolves.toEqual({
      userId: "user_1",
      teamId: "org_1",
      teamName: "acme",
    })
  })

  it("omits org keys on auth pages and returns nothing on sign-out", async () => {
    server.use(...sessionHandlers())
    await expect(
      readHyperDxDocumentIdentity(
        documentRequest("/.auth/sign-in", "session=abc"),
        "/.auth/sign-in",
      ),
    ).resolves.toEqual({ userId: "user_1", teamId: "", teamName: "" })
    await expect(
      readHyperDxDocumentIdentity(
        documentRequest("/.auth/sign-out", "session=abc"),
        "/.auth/sign-out",
      ),
    ).resolves.toBeNull()
  })

  it("does not call auth when the document has no cookie", async () => {
    await expect(
      readHyperDxDocumentIdentity(documentRequest("/acme"), "/acme"),
    ).resolves.toBeNull()
  })
})
