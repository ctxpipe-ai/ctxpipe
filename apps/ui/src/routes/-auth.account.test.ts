import { QueryClient } from "@tanstack/react-query"
import { createMemoryHistory, createRouter } from "@tanstack/react-router"
import { describe, expect, it } from "vitest"
import { routeTree } from "@/routeTree.gen"

function matchedRouteIds(pathname: string) {
  const router = createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: [pathname] }),
    context: { queryClient: new QueryClient() },
  })
  return router.matchRoutes(pathname).map((match) => match.routeId)
}

describe("account route matching", () => {
  it("matches a leaf on the bare account path so the outlet is not empty", () => {
    const ids = matchedRouteIds("/.auth/account")
    expect(ids.at(-1)).not.toBe("/.auth/account")
    expect(ids).not.toContain("/.auth/$authView")
  })

  it("still matches a named account view", () => {
    const ids = matchedRouteIds("/.auth/account/security")
    expect(ids.at(-1)).toBe("/.auth/account/$accountView")
  })
})
