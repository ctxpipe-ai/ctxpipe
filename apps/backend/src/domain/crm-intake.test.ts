import { describe, expect, it } from "vitest"

import { useMswServer } from "../../test/msw.js"
import {
  crmIntakeRecords,
  retryDelayMs,
  startCrmIntakeSender,
} from "./crm-intake.js"

// No handler: a request to the intake fails the test.
useMswServer()

const production = {
  DATABASE_URL: "postgres://localhost:5432/ctxpipe",
  AUTH_SECRET: "abcdefghijklmnopqrstuvwxyz123456",
  DEPLOYMENT_ENVIRONMENT: "production",
  CRM_INTAKE_URL: "https://crm.example.test/intake/v1/contacts",
  CRM_INTAKE_ACCESS_CLIENT_ID: "test-client-id",
  CRM_INTAKE_ACCESS_CLIENT_SECRET: "test-client-secret",
}

describe("CRM intake setting", () => {
  it("records sign-ups only in production with CRM_INTAKE_URL", () => {
    expect(crmIntakeRecords(production)).toBe(true)
    expect(crmIntakeRecords({ ...production, CRM_INTAKE_URL: "" })).toBe(false)
  })

  it.each([
    ["a preview", { DEPLOYMENT_ENVIRONMENT: "pr-12" }],
    // A Railway preview copies the production variables.
    ["a Railway preview", { RAILWAY_ENVIRONMENT_NAME: "pr-7" }],
    ["local development and self-host", { DEPLOYMENT_ENVIRONMENT: "" }],
    ["the observability stack", { DEPLOYMENT_ENVIRONMENT: "observability" }],
  ])("neither records nor sends on %s, even with the variables", (_, env) => {
    const leaked = { ...production, ...env }
    expect(crmIntakeRecords(leaked)).toBe(false)
    expect(startCrmIntakeSender(leaked)).toBe(false)
  })

  it("does not send without the Access service token", () => {
    expect(
      startCrmIntakeSender({
        ...production,
        CRM_INTAKE_ACCESS_CLIENT_SECRET: "",
      }),
    ).toBe(false)
  })

  it("refuses an intake URL that is not https", () => {
    expect(() =>
      crmIntakeRecords({
        ...production,
        CRM_INTAKE_URL: "http://crm.example.test/",
      }),
    ).toThrow()
  })
})

describe("retryDelayMs", () => {
  it("doubles from 1 minute and stops at 1 hour", () => {
    expect([1, 2, 3, 6, 7, 20].map(retryDelayMs)).toEqual([
      60_000, 120_000, 240_000, 1_920_000, 3_600_000, 3_600_000,
    ])
  })
})
