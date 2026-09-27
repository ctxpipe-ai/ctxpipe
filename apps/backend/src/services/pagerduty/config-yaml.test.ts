import { describe, expect, it } from "vitest"
import {
  hasPagerdutyConfigYamlChanged,
  parsePagerdutyConfigYamlContent,
  renderPagerdutyConfigYaml,
} from "./config-yaml.js"

describe("pagerduty config yaml", () => {
  it("round-trips selected services", () => {
    const yaml = renderPagerdutyConfigYaml({
      accountId: "acme",
      accountName: "Acme",
      accountSubdomain: "acme",
      region: "us",
      services: [
        {
          id: "PYYYYYY",
          name: "checkout-api",
          url: "https://acme.pagerduty.com/service-directory/PYYYYYY",
        },
      ],
    })
    expect(parsePagerdutyConfigYamlContent(yaml)).toEqual({
      accountId: "acme",
      accountName: "Acme",
      accountSubdomain: "acme",
      region: "us",
      services: [
        {
          id: "PYYYYYY",
          name: "checkout-api",
          url: "https://acme.pagerduty.com/service-directory/PYYYYYY",
        },
      ],
    })
  })

  it("rejects duplicate service ids", () => {
    expect(
      parsePagerdutyConfigYamlContent(`
version: 1
source: pagerduty
account:
  id: acme
  name: Acme
  subdomain: acme
  region: us
scope:
  services:
    - id: P1
      name: one
    - id: P1
      name: two
`),
    ).toBeUndefined()
  })

  it("detects semantic config changes", () => {
    const current = renderPagerdutyConfigYaml({
      accountId: "acme",
      accountName: "Acme",
      accountSubdomain: "acme",
      region: "us",
      services: [{ id: "P1", name: "one" }],
    })
    const next = renderPagerdutyConfigYaml({
      accountId: "acme",
      accountName: "Acme",
      accountSubdomain: "acme",
      region: "us",
      services: [{ id: "P2", name: "two" }],
    })
    expect(hasPagerdutyConfigYamlChanged({ current, next })).toBe(true)
    expect(hasPagerdutyConfigYamlChanged({ current, next: current })).toBe(
      false,
    )
  })
})
