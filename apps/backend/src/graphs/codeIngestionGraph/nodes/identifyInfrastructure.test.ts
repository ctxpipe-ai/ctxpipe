import { describe, expect, it } from "vitest"
import {
  normalizeInfraType,
  processCapturedInfrastructure,
} from "./identifyInfrastructurePostProcess.js"

describe("identifyInfrastructure", () => {
  describe("normalizeInfraType", () => {
    it("normalizes Docker variants", () => {
      expect(normalizeInfraType("Docker")).toBe("Docker")
      expect(normalizeInfraType("docker")).toBe("Docker")
    })

    it("normalizes Docker Compose before Docker", () => {
      expect(normalizeInfraType("Docker Compose")).toBe("Docker Compose")
      expect(normalizeInfraType("docker-compose")).toBe("Docker Compose")
    })

    it("normalizes Kubernetes and k8s", () => {
      expect(normalizeInfraType("Kubernetes")).toBe("Kubernetes")
      expect(normalizeInfraType("k8s")).toBe("Kubernetes")
    })

    it("normalizes serverless, Lambda, Cloud Run", () => {
      expect(normalizeInfraType("Serverless")).toBe("Serverless")
      expect(normalizeInfraType("AWS Lambda")).toBe("Lambda")
      expect(normalizeInfraType("Cloud Run")).toBe("Cloud Run")
    })

    it("normalizes Terraform and Pulumi", () => {
      expect(normalizeInfraType("Terraform")).toBe("Terraform")
      expect(normalizeInfraType("Pulumi")).toBe("Pulumi")
    })

    it("returns unknown types as-is", () => {
      expect(normalizeInfraType("Custom Platform")).toBe("Custom Platform")
    })
  })

  describe("processCapturedInfrastructure", () => {
    const repositoryId = "repo_abc"
    const targetHash = "abc123"

    it("produces Infrastructure objects and RUNS_ON claims", () => {
      const captured = [
        { infraType: "Docker", path: "apps/api", evidence: "Dockerfile" },
      ]
      const { extractedObjects, extractedClaims } =
        processCapturedInfrastructure(
          captured,
          repositoryId,
          ["./"],
          targetHash,
        )

      expect(extractedObjects).toHaveLength(1)
      expect(extractedObjects[0]).toMatchObject({
        kind: "Infrastructure",
        deduplicationKey: "inf:repo_abc:./:Docker",
        name: "Docker",
        summary: "Docker used by ./",
        payload: {
          infra_kind: "Docker",
          path: "apps/api",
          evidence: "Dockerfile",
        },
      })

      expect(extractedClaims).toHaveLength(1)
      expect(extractedClaims[0]).toMatchObject({
        subjectRef: "svc:repo_abc:./",
        subjectKind: "Service",
        objectRef: "inf:repo_abc:./:Docker",
        objectKind: "Infrastructure",
        predicate: "RUNS_ON",
        sourceId: "identifyInfrastructure:repo_abc:./:Docker:abc123",
        sourceType: "git",
        extractionMethod: "llm",
        confidence: 0.8,
      })
    })

    it("deduplicates by inf:repositoryId:root:infraType", () => {
      const captured = [
        { infraType: "Docker", path: "apps/web", evidence: "Dockerfile" },
        { infraType: "docker", path: "apps/web", evidence: "duplicate" },
      ]
      const { extractedObjects, extractedClaims } =
        processCapturedInfrastructure(
          captured,
          repositoryId,
          ["./"],
          targetHash,
        )

      expect(extractedObjects).toHaveLength(1)
      expect(extractedClaims).toHaveLength(1)
      expect(extractedObjects[0].payload).toMatchObject({
        evidence: "Dockerfile; duplicate",
      })
    })

    it("filters by pathMatchesRoot", () => {
      const captured = [
        { infraType: "Kubernetes", path: "apps/other/deploy", evidence: "k8s" },
      ]
      const { extractedObjects, extractedClaims } =
        processCapturedInfrastructure(
          captured,
          repositoryId,
          ["apps/api"],
          targetHash,
        )

      expect(extractedObjects).toHaveLength(0)
      expect(extractedClaims).toHaveLength(0)
    })

    it("includes infra when path matches root", () => {
      const captured = [
        { infraType: "Kubernetes", path: "apps/api", evidence: "k8s" },
      ]
      const { extractedObjects } = processCapturedInfrastructure(
        captured,
        repositoryId,
        ["apps/api"],
        targetHash,
      )

      expect(extractedObjects).toHaveLength(1)
      expect(extractedObjects[0].deduplicationKey).toBe(
        "inf:repo_abc:apps/api:Kubernetes",
      )
    })

    it("attributes to the most specific root when ./ and package roots are both listed", () => {
      const captured = [
        { infraType: "Docker", path: "apps/web", evidence: "Dockerfile" },
      ]
      const { extractedObjects, extractedClaims } =
        processCapturedInfrastructure(
          captured,
          repositoryId,
          ["./", "apps/web"],
          targetHash,
        )

      expect(extractedObjects).toHaveLength(1)
      expect(extractedObjects[0].deduplicationKey).toBe(
        "inf:repo_abc:apps/web:Docker",
      )
      expect(extractedClaims).toHaveLength(1)
      expect(extractedClaims[0].subjectRef).toBe("svc:repo_abc:apps/web")
    })
  })
})
