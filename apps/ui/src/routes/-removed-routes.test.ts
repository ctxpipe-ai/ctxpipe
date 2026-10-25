import { isRedirect } from "@tanstack/react-router"
import { describe, expect, it } from "vitest"

import { getRouter } from "@/router"

describe("removed org routes", () => {
  it.each([
    "/acme/repositories",
    "/acme/repositories/",
    "/acme/repositories/repo_1/files",
    "/acme/repositories/github/setup",
    "/acme/chat",
    "/acme/chat/conv_1",
    "/acme/knowledge-graph",
  ])("redirects %s to the organization home", (path) => {
    const router = getRouter()
    const matches = router.matchRoutes(path)
    const leaf = matches.at(-1)
    const route = Object.entries(router.routesById).find(
      ([id]) => id === leaf?.routeId,
    )?.[1]
    let thrown: unknown
    try {
      ;(route?.options.beforeLoad as ((c: never) => void) | undefined)?.({
        params: { orgSlug: "acme" },
      } as never)
    } catch (error) {
      thrown = error
    }
    expect(isRedirect(thrown)).toBe(true)
    expect((thrown as { options: unknown }).options).toMatchObject({
      to: "/$orgSlug",
      params: { orgSlug: "acme" },
    })
  })
})
