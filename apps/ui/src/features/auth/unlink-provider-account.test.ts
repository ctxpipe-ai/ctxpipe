import { createAuthClient } from "better-auth/react"
import { HttpResponse, http } from "msw"
import { setupServer } from "msw/node"
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest"

import { unlinkProviderAccount } from "./unlink-provider-account"

const base = "http://localhost:3000"
const authBase = `${base}/.auth/api/v1/auth`

// Two providers can give the same account id, so the provider id decides.
const linkedAccounts = [
  {
    id: "acc_row_atlassian",
    providerId: "atlassian",
    accountId: "583231",
    userId: "user_1",
    scopes: [],
    createdAt: "2026-11-01T00:00:00.000Z",
    updatedAt: "2026-11-01T00:00:00.000Z",
  },
  {
    id: "acc_row_github",
    providerId: "github",
    accountId: "583231",
    userId: "user_1",
    scopes: [],
    createdAt: "2026-11-01T00:00:00.000Z",
    updatedAt: "2026-11-01T00:00:00.000Z",
  },
]

let unlinkBodies: unknown[] = []
const server = setupServer(
  http.get(`${authBase}/list-accounts`, () =>
    HttpResponse.json(linkedAccounts),
  ),
  http.post(`${authBase}/unlink-account`, async ({ request }) => {
    const body = (await request.json()) as { accountId: string }
    unlinkBodies.push(body)
    return linkedAccounts.some((account) => account.id === body.accountId)
      ? HttpResponse.json({ status: true })
      : HttpResponse.json(
          { code: "ACCOUNT_NOT_FOUND", message: "Account not found" },
          { status: 400 },
        )
  }),
)

const client = createAuthClient({
  baseURL: base,
  basePath: "/.auth/api/v1/auth",
  fetchOptions: {
    customFetchImpl: (input, init) => globalThis.fetch(input, init),
  },
})

describe("unlinkProviderAccount", () => {
  beforeAll(() => server.listen({ onUnhandledRequest: "error" }))
  afterEach(() => {
    unlinkBodies = []
    server.resetHandlers()
  })
  afterAll(() => server.close())

  it("unlinks the row of the provider account that the settings page shows", async () => {
    await unlinkProviderAccount(client, {
      providerId: "github",
      accountId: "583231",
    })

    expect(unlinkBodies).toEqual([{ accountId: "acc_row_github" }])
  })

  it("fails with the server error when the user has no such account", async () => {
    await expect(
      unlinkProviderAccount(client, { providerId: "google", accountId: "1" }),
    ).rejects.toMatchObject({ code: "ACCOUNT_NOT_FOUND" })
  })
})
