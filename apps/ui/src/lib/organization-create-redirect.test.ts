import type { QueryClient } from "@tanstack/react-query"
import { describe, expect, it, vi } from "vitest"
import {
  handleOrganizationCreateSuccess,
  isOrganizationCreateRequest,
  onAuthClientOrganizationCreateSuccess,
  resolveOrganizationCreatePathname,
  setOrganizationCreateRedirectDeps,
} from "./organization-create-redirect"

describe("resolveOrganizationCreatePathname", () => {
  it("keeps relative auth paths", () => {
    expect(resolveOrganizationCreatePathname("/organization/create")).toBe(
      "/organization/create",
    )
  })

  it("extracts pathname from absolute URLs", () => {
    expect(
      resolveOrganizationCreatePathname(
        "http://localhost:3000/.auth/api/v1/auth/organization/create",
      ),
    ).toBe("/.auth/api/v1/auth/organization/create")
  })
})

describe("isOrganizationCreateRequest", () => {
  it("matches organization create POST on full auth path", () => {
    expect(
      isOrganizationCreateRequest(
        "/.auth/api/v1/auth/organization/create",
        "POST",
      ),
    ).toBe(true)
  })

  it("matches organization create POST on better-auth relative path", () => {
    expect(isOrganizationCreateRequest("/organization/create", "POST")).toBe(
      true,
    )
  })

  it("ignores other routes and methods", () => {
    expect(
      isOrganizationCreateRequest(
        "/.auth/api/v1/auth/organization/list",
        "GET",
      ),
    ).toBe(false)
  })
})

describe("handleOrganizationCreateSuccess", () => {
  it("redirects to org setup after successful create outside onboarding", async () => {
    const queryClient = {
      invalidateQueries: vi.fn().mockResolvedValue(undefined),
    } as unknown as QueryClient
    const navigate = vi.fn().mockResolvedValue(undefined)

    await handleOrganizationCreateSuccess(
      { slug: "new-org", id: "1" },
      {
        queryClient,
        router: { navigate },
        pathname: "/acme",
      },
    )

    expect(queryClient.invalidateQueries).toHaveBeenCalledWith({
      queryKey: ["organizations"],
      refetchType: "active",
    })
    expect(navigate).toHaveBeenCalledWith({
      to: "/$orgSlug/setup",
      params: { orgSlug: "new-org" },
      replace: true,
    })
  })

  it("invalidates org list but skips redirect on onboarding", async () => {
    const queryClient = {
      invalidateQueries: vi.fn().mockResolvedValue(undefined),
    } as unknown as QueryClient
    const navigate = vi.fn()

    await handleOrganizationCreateSuccess(
      { slug: "new-org", id: "1" },
      {
        queryClient,
        router: { navigate },
        pathname: "/onboarding",
      },
    )

    expect(queryClient.invalidateQueries).toHaveBeenCalled()
    expect(navigate).not.toHaveBeenCalled()
  })
})

describe("onAuthClientOrganizationCreateSuccess", () => {
  it("redirects when auth client onSuccess fires for organization create", async () => {
    const queryClient = {
      invalidateQueries: vi.fn().mockResolvedValue(undefined),
    } as unknown as QueryClient
    const navigate = vi.fn().mockResolvedValue(undefined)

    setOrganizationCreateRedirectDeps({
      queryClient,
      router: { navigate },
      getPathname: () => "/acme",
    })

    await onAuthClientOrganizationCreateSuccess({
      data: { slug: "new-org", id: "1" },
      request: {
        url: "/organization/create",
        method: "POST",
      },
    })

    expect(navigate).toHaveBeenCalledWith({
      to: "/$orgSlug/setup",
      params: { orgSlug: "new-org" },
      replace: true,
    })

    setOrganizationCreateRedirectDeps(null)
  })
})
