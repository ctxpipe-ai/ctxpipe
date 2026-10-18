import { renderToString } from "react-dom/server"
import { afterEach, describe, expect, it, vi } from "vitest"
import { onboardingHandOffFlag, useSessionFlag } from "./session-flags"

function Probe() {
  const set = useSessionFlag(onboardingHandOffFlag)
  return <div data-held={set ? "yes" : "no"} />
}

describe("useSessionFlag", () => {
  afterEach(() => vi.unstubAllGlobals())

  it("renders false in the server markup, so hydration matches", () => {
    // A tab with the flag set: the client first render must still read false.
    vi.stubGlobal("sessionStorage", { getItem: () => "1" })
    expect(onboardingHandOffFlag.isSet()).toBe(true)
    expect(renderToString(<Probe />)).toContain('data-held="no"')
  })
})
