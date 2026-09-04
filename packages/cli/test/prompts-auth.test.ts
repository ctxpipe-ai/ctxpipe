import { beforeEach, describe, expect, it, vi } from "vitest"

const {
  ensureFreshAccessTokenMock,
  fetchOrganizationsMock,
  fetchSessionMock,
  loginWithDeviceFlowMock,
  reauthenticationRequiredMock,
  spinnerStopMock,
  textMock,
} = vi.hoisted(() => ({
  ensureFreshAccessTokenMock: vi.fn(),
  fetchOrganizationsMock: vi.fn(),
  fetchSessionMock: vi.fn(),
  loginWithDeviceFlowMock: vi.fn(),
  reauthenticationRequiredMock: vi.fn(),
  spinnerStopMock: vi.fn(),
  textMock: vi.fn(),
}))

vi.mock("../src/auth.js", () => ({
  ensureFreshAccessToken: ensureFreshAccessTokenMock,
  fetchOrganizations: fetchOrganizationsMock,
  fetchSession: fetchSessionMock,
  isAuthReauthenticationRequired: reauthenticationRequiredMock,
  loginWithDeviceFlow: loginWithDeviceFlowMock,
  orgLabel: (org: { slug: string }) => org.slug,
  userLabel: () => null,
}))

vi.mock("@clack/prompts", () => ({
  confirm: vi.fn(),
  isCancel: () => false,
  log: {
    message: vi.fn(),
    step: vi.fn(),
    success: vi.fn(),
  },
  multiselect: vi.fn(),
  select: vi.fn(),
  spinner: () => ({
    start: vi.fn(),
    stop: spinnerStopMock,
  }),
  text: textMock,
}))

vi.mock("../src/ui.js", () => ({
  muted: (value: string) => value,
  printWizardHeader: vi.fn(),
}))

import { type InitPromptState, promptInitWizard } from "../src/prompts.js"

const current: InitPromptState = {
  org: null,
  baseUrl: "https://app.ctxpipe.ai",
  agents: ["cursor"],
  scope: "repo",
  mcp: true,
  memory: false,
}

describe("init auth prompts", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ensureFreshAccessTokenMock.mockResolvedValue({
      accessToken: "stored-token",
    })
    fetchSessionMock.mockResolvedValue({})
    loginWithDeviceFlowMock.mockResolvedValue({
      accessToken: "fresh-token",
    })
    textMock.mockResolvedValue("manual-org")
  })

  it("stops on temporary organisation failures instead of forcing login", async () => {
    const temporaryError = new Error("temporarily unavailable")
    fetchOrganizationsMock.mockRejectedValue(temporaryError)
    reauthenticationRequiredMock.mockReturnValue(false)

    await expect(promptInitWizard(current)).rejects.toBe(temporaryError)

    expect(loginWithDeviceFlowMock).not.toHaveBeenCalled()
    expect(spinnerStopMock).toHaveBeenCalledWith(
      "ctx| is temporarily unavailable",
    )
  })

  it("starts login only after an authentication failure", async () => {
    const authenticationError = new Error("expired")
    fetchOrganizationsMock
      .mockRejectedValueOnce(authenticationError)
      .mockResolvedValueOnce([{ id: "org_1", name: "Acme", slug: "acme" }])
    reauthenticationRequiredMock.mockImplementation(
      (error: unknown) => error === authenticationError,
    )

    await expect(promptInitWizard(current)).resolves.toMatchObject({
      org: "acme",
    })
    expect(loginWithDeviceFlowMock).toHaveBeenCalledTimes(1)
  })

  it("does not relogin after a successful empty organisation list", async () => {
    fetchOrganizationsMock.mockResolvedValue([])
    reauthenticationRequiredMock.mockReturnValue(false)

    await expect(promptInitWizard(current)).resolves.toMatchObject({
      org: "manual-org",
    })
    expect(loginWithDeviceFlowMock).not.toHaveBeenCalled()
  })
})
