import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import { GithubNotLinkedNotice } from "./GithubNotLinkedNotice"

describe("GithubNotLinkedNotice", () => {
  it("offers to connect GitHub when the deployment has GitHub sign-in", () => {
    const html = renderToStaticMarkup(
      <GithubNotLinkedNotice githubSignInEnabled orgSlug="acme" />,
    )

    expect(html).toContain("Connect GitHub")
  })

  it("points to the organization's own App when GitHub sign-in is off", () => {
    const html = renderToStaticMarkup(
      <GithubNotLinkedNotice githubSignInEnabled={false} orgSlug="acme" />,
    )

    expect(html).toContain("GitHub sign-in is not enabled on this deployment")
    expect(html).toContain('href="/acme/connectors"')
    expect(html).not.toContain("Connect GitHub")
  })
})
