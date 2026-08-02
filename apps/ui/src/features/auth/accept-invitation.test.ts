import { describe, expect, it, vi } from "vitest"
import { acceptInvitationThenRedirect } from "./accept-invitation"

describe("acceptInvitationThenRedirect", () => {
  it("redirects after invitation acceptance succeeds", async () => {
    const acceptInvitation = vi.fn().mockResolvedValue(undefined)
    const redirect = vi.fn()

    await acceptInvitationThenRedirect(acceptInvitation, redirect)

    expect(acceptInvitation).toHaveBeenCalledOnce()
    expect(redirect).toHaveBeenCalledOnce()
  })

  it("does not redirect when invitation acceptance fails", async () => {
    const error = new Error("Invitation could not be accepted")
    const acceptInvitation = vi.fn().mockRejectedValue(error)
    const redirect = vi.fn()

    await expect(
      acceptInvitationThenRedirect(acceptInvitation, redirect),
    ).rejects.toBe(error)
    expect(redirect).not.toHaveBeenCalled()
  })
})
