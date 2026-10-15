import { describe, expect, it } from "vitest"
import {
  getLinearCardPrimaryCta,
  getLinearSetupCurrentIndex,
  getLinearWizardBodyId,
  LINEAR_SETUP_STEPS,
  SELF_HOSTED_LINEAR_SETUP_STEPS,
} from "./linear-setup-model"

const draft = { isInstalled: false }
const installed = { isInstalled: true }
const hosted = { globalLinearOauthConfigured: true, oauthAppSaved: false }
const selfHostUnsaved = {
  globalLinearOauthConfigured: false,
  oauthAppSaved: false,
}
const selfHostSaved = {
  globalLinearOauthConfigured: false,
  oauthAppSaved: true,
}

describe("Linear setup model", () => {
  it("connects first, then chooses Workspaces", () => {
    expect(getLinearWizardBodyId(draft, hosted)).toBe("connect")
    expect(getLinearSetupCurrentIndex(draft, hosted)).toBe(0)
    expect(getLinearWizardBodyId(installed, hosted)).toBe("workspaces")
    expect(getLinearSetupCurrentIndex(installed, hosted)).toBe(
      LINEAR_SETUP_STEPS.findIndex((step) => step.id === "workspaces"),
    )
  })

  it("has no sync repository, scope, or merge step", () => {
    expect(SELF_HOSTED_LINEAR_SETUP_STEPS.map((step) => step.id)).toEqual([
      "register",
      "connect",
      "workspaces",
    ])
  })

  it("inserts Register before Connect when the OAuth app is not configured", () => {
    expect(getLinearWizardBodyId(draft, selfHostUnsaved)).toBe("register")
    expect(getLinearSetupCurrentIndex(draft, selfHostUnsaved)).toBe(0)
    expect(getLinearWizardBodyId(draft, selfHostSaved)).toBe("connect")
    expect(getLinearSetupCurrentIndex(draft, selfHostSaved)).toBe(1)
  })

  it("gives the card a setup action, then Manage once installed", () => {
    expect(getLinearCardPrimaryCta(draft, selfHostUnsaved)).toEqual({
      label: "Register OAuth app",
    })
    expect(getLinearCardPrimaryCta(draft, hosted)).toEqual({
      label: "Connect Linear",
    })
    expect(getLinearCardPrimaryCta(installed, hosted)).toEqual({
      label: "Manage",
    })
  })
})
