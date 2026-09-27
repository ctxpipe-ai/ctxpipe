import HyperDX from "@hyperdx/browser"
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
import { authClient } from "./auth-client"

const server = setupServer()

beforeAll(() => {
  server.listen({ onUnhandledRequest: "error" })
})

afterEach(() => {
  server.resetHandlers()
  const session = authClient.$store.atoms.session
  const current = session.get()
  session.set({ ...current, data: null, error: null, isPending: false })
  vi.restoreAllMocks()
})

afterAll(() => {
  server.close()
})

function post(path: string, data: Parameters<typeof HttpResponse.json>[0]) {
  server.use(
    http.post(`*/.auth/api/v1/auth${path}`, () => HttpResponse.json(data)),
  )
}

async function call(path: string, body: Record<string, string>) {
  await authClient.$fetch(path, { method: "POST", body })
}

describe("sign_in", () => {
  it("fires for email sign-in and backup-code verify when no session exists", async () => {
    const addAction = vi
      .spyOn(HyperDX, "addAction")
      .mockImplementation(() => {})
    post("/sign-in/email", { token: "t", user: { id: "user_1" } })
    await call("/sign-in/email", {
      email: "a@b.c",
      password: "secret-secret",
    })
    expect(addAction).toHaveBeenCalledWith("sign_in")

    addAction.mockClear()
    post("/two-factor/verify-backup-code", {
      token: "t",
      user: { id: "user_1" },
    })
    await call("/two-factor/verify-backup-code", { code: "backup" })
    expect(addAction).toHaveBeenCalledWith("sign_in")
  })

  it("does not fire for a 2FA challenge redirect or enrollment verify", async () => {
    const addAction = vi
      .spyOn(HyperDX, "addAction")
      .mockImplementation(() => {})
    post("/sign-in/email", { twoFactorRedirect: true })
    await call("/sign-in/email", {
      email: "a@b.c",
      password: "secret-secret",
    })
    expect(addAction).not.toHaveBeenCalled()

    const session = authClient.$store.atoms.session
    session.set({
      ...session.get(),
      data: { user: { id: "user_1" }, session: { id: "sess" } },
      isPending: false,
      error: null,
    })
    post("/two-factor/verify-totp", { status: true })
    await call("/two-factor/verify-totp", { code: "123456" })
    expect(addAction).not.toHaveBeenCalled()
  })
})
