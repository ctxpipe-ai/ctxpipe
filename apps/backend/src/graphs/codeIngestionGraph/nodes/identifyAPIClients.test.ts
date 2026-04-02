import { describe, expect, it } from "vitest"
import {
  processApiClients,
  type SubmittedApiClient,
} from "./processApiClients.js"

describe("identifyAPIClients", () => {
  const repositoryId = "repo_test123"
  const targetHash = "abc123"

  describe("processApiClients post-processing", () => {
    it("emits stub API object and CONSUMES_API claim for internal API", () => {
      const clients: SubmittedApiClient[] = [
        {
          path: "apps/web",
          consumedApi: "apps/web/src/app/api",
          evidence: "fetch to /api/users",
        },
      ]
      const { objects, claims } = processApiClients(
        clients,
        repositoryId,
        ["apps/web"],
        targetHash,
      )

      expect(objects).toHaveLength(1)
      expect(objects[0]).toMatchObject({
        kind: "API",
        deduplicationKey: `api:${repositoryId}:apps/web:apps/web/src/app/api`,
        name: "api",
        summary: "API at apps/web/src/app/api (inferred from consumer)",
        payload: {
          path: "apps/web/src/app/api",
          inferredFromConsumer: true,
        },
      })
      expect(claims).toHaveLength(1)
      expect(claims[0]).toMatchObject({
        subjectRef: `svc:${repositoryId}:apps/web`,
        subjectKind: "Service",
        objectRef: `api:${repositoryId}:apps/web:apps/web/src/app/api`,
        objectKind: "API",
        predicate: "CONSUMES_API",
        provenance: {
          path: "apps/web",
          consumedApi: "apps/web/src/app/api",
          evidence: "fetch to /api/users",
        },
      })
    })

    it("creates API object and CONSUMES_API claim for external API", () => {
      const clients: SubmittedApiClient[] = [
        {
          path: "apps/backend",
          consumedApiName: "Stripe",
          consumedApiUrl: "STRIPE_KEY",
          evidence: "@stripe/stripe-js",
        },
      ]
      const { objects, claims } = processApiClients(
        clients,
        repositoryId,
        ["apps/backend"],
        targetHash,
      )

      expect(objects).toHaveLength(1)
      expect(objects[0]).toMatchObject({
        kind: "API",
        deduplicationKey: `api:${repositoryId}:apps/backend:external:Stripe`,
        name: "Stripe",
        summary: "External API: Stripe consumed by apps/backend",
        payload: { external: true, consumedApiUrl: "STRIPE_KEY" },
      })

      expect(claims).toHaveLength(1)
      expect(claims[0]).toMatchObject({
        subjectRef: `svc:${repositoryId}:apps/backend`,
        subjectKind: "Service",
        objectRef: `api:${repositoryId}:apps/backend:external:Stripe`,
        objectKind: "API",
        predicate: "CONSUMES_API",
        provenance: {
          path: "apps/backend",
          consumedApiName: "Stripe",
          consumedApiUrl: "STRIPE_KEY",
        },
      })
    })

    it("skips clients whose path does not match any root", () => {
      const clients: SubmittedApiClient[] = [
        {
          path: "packages/other",
          consumedApiName: "SendGrid",
        },
      ]
      const { objects, claims } = processApiClients(
        clients,
        repositoryId,
        ["apps/web", "apps/backend"],
        targetHash,
      )

      expect(objects).toHaveLength(0)
      expect(claims).toHaveLength(0)
    })

    it("skips clients with empty consumedApiName", () => {
      const clients: SubmittedApiClient[] = [
        { path: "apps/web", consumedApiName: "   " },
      ]
      const { objects, claims } = processApiClients(
        clients,
        repositoryId,
        ["apps/web"],
        targetHash,
      )

      expect(objects).toHaveLength(0)
      expect(claims).toHaveLength(0)
    })

    it("deduplicates external API objects when same name appears multiple times", () => {
      const clients: SubmittedApiClient[] = [
        { path: "apps/web", consumedApiName: "Twilio" },
        { path: "apps/web/src", consumedApiName: "Twilio" },
      ]
      const { objects, claims } = processApiClients(
        clients,
        repositoryId,
        ["apps/web"],
        targetHash,
      )

      expect(objects).toHaveLength(1)
      expect(objects[0].deduplicationKey).toBe(
        `api:${repositoryId}:apps/web:external:Twilio`,
      )
      expect(claims).toHaveLength(2)
    })

    it("matches root ./ for path at repo root", () => {
      const clients: SubmittedApiClient[] = [
        { path: ".", consumedApiName: "Supabase" },
      ]
      const { objects, claims } = processApiClients(
        clients,
        repositoryId,
        ["./"],
        targetHash,
      )

      expect(objects).toHaveLength(1)
      expect(claims).toHaveLength(1)
      expect(claims[0].subjectRef).toBe(`svc:${repositoryId}:./`)
    })

    it("attributes to the most specific root when ./ and package roots are both listed", () => {
      const clients: SubmittedApiClient[] = [
        { path: "apps/web", consumedApiName: "Twilio" },
      ]
      const { objects, claims } = processApiClients(
        clients,
        repositoryId,
        ["./", "apps/web"],
        targetHash,
      )

      expect(objects).toHaveLength(1)
      expect(claims).toHaveLength(1)
      expect(claims[0].subjectRef).toBe(`svc:${repositoryId}:apps/web`)
      expect(objects[0].deduplicationKey).toBe(
        `api:${repositoryId}:apps/web:external:Twilio`,
      )
    })

    it("produces correct api: key format for internal APIs matching identifyAPIs", () => {
      const clients: SubmittedApiClient[] = [
        {
          path: "apps/backend",
          consumedApi: "apps/backend/src/routes",
        },
      ]
      const { claims } = processApiClients(
        clients,
        repositoryId,
        ["apps/backend"],
        targetHash,
      )

      const expectedApiKey = `api:${repositoryId}:apps/backend:apps/backend/src/routes`
      expect(claims[0].objectRef).toBe(expectedApiKey)
    })
  })
})
