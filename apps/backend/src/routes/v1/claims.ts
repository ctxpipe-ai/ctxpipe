import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi"
import type { AppEnv } from "../../app/env.js"
import { requireCurrentOrgId } from "../../auth/context.js"
import { getRepository } from "../../models/repositories.js"
import { generateObjectId } from "../../lib/id.js"
import {
  createClaim,
  type CreateClaimInput,
  type InitialEvidenceInput,
} from "../../retrieval/index.js"
import { projectClaimsToGraph } from "../../retrieval/index.js"
import { upsertRetrievalObject } from "../../retrieval/services/retrievalObjectWrite.js"

const ErrorResponseSchema = z
  .object({ error: z.string() })
  .openapi("ErrorResponse")

const CreateClaimRequestSchema = z
  .object({
    subjectId: z.string().min(1),
    predicate: z.string().min(1),
    objectId: z.string().min(1),
    status: z.enum(["active", "superseded", "disputed", "deprecated"]).optional(),
    validFrom: z.string().datetime().optional(),
    validTo: z.string().datetime().optional(),
    subjectType: z.string().optional(),
    objectType: z.string().optional(),
    evidence: z
      .object({
        sourceType: z.enum([
          "confluence",
          "git",
          "pagerduty",
          "slack",
          "jira",
          "manual",
          "api",
        ]),
        sourceId: z.string(),
        sourceUrl: z.string().url().optional(),
        extractionMethod: z.enum([
          "deterministic",
          "llm",
          "imported",
          "manual",
        ]),
        confidence: z.number().min(0).max(1),
        provenance: z.record(z.string(), z.unknown()).optional(),
      })
      .optional(),
  })
  .openapi("CreateClaimRequest")

const CreateClaimResponseSchema = z
  .object({
    claimId: z.string(),
    projected: z.boolean().optional(),
  })
  .openapi("CreateClaimResponse")

const CreateServiceRepositoryClaimRequestSchema = z
  .object({
    serviceName: z.string().min(1),
    repositoryId: z.string().regex(/^repo_[a-z2-7]+$/),
    evidence: CreateClaimRequestSchema.shape.evidence.optional(),
  })
  .openapi("CreateServiceRepositoryClaimRequest")

export const createClaimRoute = createRoute({
  method: "post",
  path: "/",
  request: {
    body: {
      content: {
        "application/json": {
          schema: CreateClaimRequestSchema,
        },
      },
    },
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: CreateClaimResponseSchema,
        },
      },
      description: "Claim created",
    },
    400: {
      content: {
        "application/json": { schema: ErrorResponseSchema },
      },
      description: "Invalid request",
    },
    404: {
      content: {
        "application/json": { schema: ErrorResponseSchema },
      },
      description: "Repository not found",
    },
  },
})

export const createServiceRepositoryClaimRoute = createRoute({
  method: "post",
  path: "/service-repository",
  request: {
    body: {
      content: {
        "application/json": {
          schema: CreateServiceRepositoryClaimRequestSchema,
        },
      },
    },
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: CreateClaimResponseSchema,
        },
      },
      description: "Service RUNS_ON Repository claim created",
    },
    400: {
      content: {
        "application/json": { schema: ErrorResponseSchema },
      },
      description: "Invalid request",
    },
    404: {
      content: {
        "application/json": { schema: ErrorResponseSchema },
      },
      description: "Repository not found",
    },
  },
})

export const claimRoutes = new OpenAPIHono<AppEnv>()
  .openapi(createClaimRoute, async (c) => {
    const orgId = requireCurrentOrgId()
    const body = c.req.valid("json")

    const input: CreateClaimInput = {
      subjectId: body.subjectId,
      predicate: body.predicate,
      objectId: body.objectId,
      status: body.status,
      subjectType: body.subjectType,
      objectType: body.objectType,
      validFrom: body.validFrom ? new Date(body.validFrom) : undefined,
      validTo: body.validTo ? new Date(body.validTo) : undefined,
    }

    const initialEvidence: InitialEvidenceInput | undefined = body.evidence
      ? {
          sourceType: body.evidence.sourceType,
          sourceId: body.evidence.sourceId,
          sourceUrl: body.evidence.sourceUrl ?? undefined,
          extractionMethod: body.evidence.extractionMethod,
          confidence: body.evidence.confidence,
          provenance: body.evidence.provenance ?? undefined,
        }
      : undefined

    const claimId = await createClaim(orgId, input, initialEvidence)

    return c.json({ claimId }, 200)
  })
  .openapi(createServiceRepositoryClaimRoute, async (c) => {
    const orgId = requireCurrentOrgId()
    const orgSlug = c.get("orgSlug")
    if (!orgSlug) {
      return c.json({ error: "Missing org context" }, 400)
    }

    const body = c.req.valid("json")

    const repository = await getRepository(body.repositoryId)
    if (!repository) {
      return c.json({ error: "Repository not found" }, 404)
    }

    const serviceId = generateObjectId("svc")
    await upsertRetrievalObject(orgId, {
      id: serviceId,
      type: "Service",
      payload: {
        name: body.serviceName,
        summary: `Service ${body.serviceName}`,
      },
    })

    const initialEvidence: InitialEvidenceInput | undefined = body.evidence
      ? {
          sourceType: body.evidence.sourceType,
          sourceId: body.evidence.sourceId,
          sourceUrl: body.evidence.sourceUrl ?? undefined,
          extractionMethod: body.evidence.extractionMethod,
          confidence: body.evidence.confidence,
          provenance: body.evidence.provenance ?? undefined,
        }
      : {
          sourceType: "manual",
          sourceId: `service:${body.serviceName}`,
          extractionMethod: "manual",
          confidence: 0.9,
        }

    const claimId = await createClaim(
      orgId,
      {
        subjectId: serviceId,
        predicate: "RUNS_ON",
        objectId: body.repositoryId,
        subjectType: "Service",
        objectType: "Repository",
      },
      initialEvidence,
    )

    const { projected } = await projectClaimsToGraph(orgId, orgSlug, {
      claimIds: [claimId],
    })

    return c.json({ claimId, projected: projected >= 1 }, 200)
  })
