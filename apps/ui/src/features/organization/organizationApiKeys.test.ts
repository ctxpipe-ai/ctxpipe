import { describe, expect, it } from "vitest"

import {
  organizationApiKeyCreateRequest,
  organizationApiKeyDeleteRequest,
  organizationApiKeyListRequest,
  organizationApiKeyNeverExpiresRequest,
} from "./organizationApiKeys"

describe("organization API-key client", () => {
  it("lists only the requested organisation key configuration", () => {
    expect(organizationApiKeyListRequest("org_acme")).toEqual({
      query: {
        configId: "organization",
        organizationId: "org_acme",
      },
    })
  })

  it("creates organisation-owned keys and explicitly clears a never expiry", () => {
    expect(
      organizationApiKeyCreateRequest({
        organizationId: "org_acme",
        name: "coderabbit",
        expiresIn: null,
      }),
    ).toEqual({
      configId: "organization",
      organizationId: "org_acme",
      name: "coderabbit",
      expiresIn: undefined,
      fetchOptions: { throw: true },
    })
    expect(organizationApiKeyNeverExpiresRequest("key_org")).toEqual({
      keyId: "key_org",
      configId: "organization",
      expiresIn: null,
      fetchOptions: { throw: true },
    })
  })

  it("revokes only through the organisation key configuration", () => {
    expect(organizationApiKeyDeleteRequest("key_org")).toEqual({
      keyId: "key_org",
      configId: "organization",
      fetchOptions: { throw: true },
    })
  })
})
