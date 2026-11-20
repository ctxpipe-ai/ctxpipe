import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"

import { GithubOwnAppNotice } from "./GithubOwnAppNotice"

describe("GithubOwnAppNotice", () => {
  it("points to the organization's own App", () => {
    const html = renderToStaticMarkup(<GithubOwnAppNotice orgSlug="acme" />)

    expect(html).toContain("GitHub sign-in is not enabled on this deployment")
    expect(html).toContain('href="/acme/connectors"')
  })
})
