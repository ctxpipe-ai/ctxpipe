import { and, eq } from "drizzle-orm"
import { requireCurrentOrgId } from "../../../auth/context.js"
import { getOrgDb } from "../../../db/client.js"
import { claimEvidence } from "../../../db/schema/claim_evidence.js"
import { claims } from "../../../db/schema/claims.js"
import { retrievalObjects } from "../../../db/schema/retrieval_objects.js"
import {
  createClaim,
  addEvidence,
} from "../../../retrieval/services/claimWrite.js"
import { upsertRetrievalObjectByDeduplicationKey } from "../../../retrieval/services/retrievalObjectWrite.js"
import { isIdRef } from "../schemas.js"
import type { CodeIngestionState } from "../schemas.js"

function resolveRef(ref: string, keyToId: Map<string, string>): string {
  if (isIdRef(ref)) return ref
  const id = keyToId.get(ref)
  if (id) return id
  throw new Error(`Unresolved ref: ${ref}`)
}

export async function deduplicateAndStore(
  state: CodeIngestionState,
): Promise<Partial<CodeIngestionState>> {
  console.log("deduplicating and storing", state)
  const orgId = requireCurrentOrgId()
  const db = getOrgDb()
  const { extractedObjects = [], extractedClaims = [] } = state

  const objectIds: string[] = []
  const claimIds: string[] = []
  const keyToId = new Map<string, string>()
  const keyToType = new Map<string, string>()
  for (const obj of extractedObjects) {
    keyToType.set(obj.deduplicationKey, obj.type as string)
  }

  for (const obj of extractedObjects) {
    const existing = await db
      .select({ id: retrievalObjects.id })
      .from(retrievalObjects)
      .where(
        and(
          eq(retrievalObjects.orgId, orgId),
          eq(retrievalObjects.deduplicationKey, obj.deduplicationKey as string),
        ),
      )
      .limit(1)

    let id: string
    if (existing[0]) {
      id = existing[0].id
    } else {
      const payload: Record<string, unknown> = {
        name: obj.name,
        summary: obj.summary,
        ...(typeof obj.payload === "object" && obj.payload !== null
          ? obj.payload
          : {}),
      }
      id = await upsertRetrievalObjectByDeduplicationKey(orgId, {
        type: obj.type as string,
        deduplicationKey: obj.deduplicationKey,
        payload,
      })
    }
    keyToId.set(obj.deduplicationKey, id)
    objectIds.push(id)
  }

  for (const c of extractedClaims) {
    const subjectId = resolveRef(c.subjectRef, keyToId)
    const objectId = resolveRef(c.objectRef, keyToId)
    const subjectType = isIdRef(c.subjectRef)
      ? undefined
      : (keyToType.get(c.subjectRef) ?? undefined)
    const objectType = isIdRef(c.objectRef)
      ? undefined
      : (keyToType.get(c.objectRef) ?? undefined)

    const existingClaimWithEvidence = await db
      .select({
        claimId: claims.id,
        sourceId: claimEvidence.sourceId,
      })
      .from(claims)
      .innerJoin(claimEvidence, eq(claims.id, claimEvidence.claimId))
      .where(
        and(
          eq(claims.orgId, orgId),
          eq(claims.subjectId, subjectId),
          eq(claims.predicate, c.predicate),
          eq(claims.objectId, objectId),
          eq(claimEvidence.sourceId, c.sourceId),
        ),
      )
      .limit(1)

    if (existingClaimWithEvidence[0]) {
      continue
    }

    const existingClaim = await db
      .select({ id: claims.id })
      .from(claims)
      .where(
        and(
          eq(claims.orgId, orgId),
          eq(claims.subjectId, subjectId),
          eq(claims.predicate, c.predicate),
          eq(claims.objectId, objectId),
        ),
      )
      .limit(1)

    if (existingClaim[0]) {
      await addEvidence(orgId, {
        claimId: existingClaim[0].id,
        sourceType: c.sourceType,
        sourceId: c.sourceId,
        extractionMethod: c.extractionMethod,
        confidence: c.confidence,
        provenance: c.provenance ?? null,
      })
      claimIds.push(existingClaim[0].id)
    } else {
      const claimId = await createClaim(
        orgId,
        {
          subjectId,
          predicate: c.predicate,
          objectId,
          ...(subjectType && { subjectType }),
          ...(objectType && { objectType }),
        },
        {
          sourceType: c.sourceType,
          sourceId: c.sourceId,
          extractionMethod: c.extractionMethod,
          confidence: c.confidence,
          provenance: c.provenance ?? null,
        },
      )
      claimIds.push(claimId)
    }
  }

  return {
    objectIds: [...new Set(objectIds)],
    claimIds: [...new Set(claimIds)],
  }
}
