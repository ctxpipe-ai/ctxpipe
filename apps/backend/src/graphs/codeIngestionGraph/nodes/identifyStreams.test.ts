import { describe, expect, it } from "vitest"
import {
  processStreamSubmissions,
  type SubmittedStream,
} from "./identifyStreamsProcess.js"

const baseState = {
  repositoryId: "repo-1",
  roots: ["apps/web"],
  targetHash: "abc123",
}

describe("processStreamSubmissions", () => {
  it("produces Stream objects with correct deduplication keys", () => {
    const streams: SubmittedStream[] = [
      {
        streamType: "Kafka",
        path: "apps/web",
        role: "producer",
        evidence: "kafkajs",
      },
    ]
    const { objects } = processStreamSubmissions(streams, baseState)

    expect(objects).toHaveLength(1)
    expect(objects[0]).toMatchObject({
      kind: "Stream",
      deduplicationKey: "stream:repo-1:apps/web:Kafka",
      name: "Kafka",
      summary: "Kafka used by apps/web",
    })
  })

  it("deduplicates streams by repositoryId:root:streamType", () => {
    const streams: SubmittedStream[] = [
      { streamType: "Kafka", path: "apps/web", role: "producer" },
      { streamType: "kafka", path: "apps/web/src", role: "consumer" },
    ]
    const { objects, claims } = processStreamSubmissions(streams, {
      ...baseState,
      roots: ["apps/web"],
    })

    expect(objects).toHaveLength(1)
    expect(objects[0].deduplicationKey).toBe("stream:repo-1:apps/web:Kafka")

    const predicates = claims.map((c) => c.predicate)
    expect(predicates).toContain("PRODUCES_TO")
    expect(predicates).toContain("CONSUMES_FROM")
  })

  it("maps role producer to PRODUCES_TO claim", () => {
    const streams: SubmittedStream[] = [
      { streamType: "RabbitMQ", path: "apps/api", role: "producer" },
    ]
    const { claims } = processStreamSubmissions(streams, {
      ...baseState,
      roots: ["apps/api"],
    })

    expect(claims).toHaveLength(1)
    expect(claims[0]).toMatchObject({
      subjectRef: "svc:repo-1:apps/api",
      subjectKind: "Service",
      objectRef: "stream:repo-1:apps/api:RabbitMQ",
      objectKind: "Stream",
      predicate: "PRODUCES_TO",
    })
  })

  it("maps role consumer to CONSUMES_FROM claim", () => {
    const streams: SubmittedStream[] = [
      { streamType: "SQS", path: "apps/worker", role: "consumer" },
    ]
    const { claims } = processStreamSubmissions(streams, {
      ...baseState,
      roots: ["apps/worker"],
    })

    expect(claims).toHaveLength(1)
    expect(claims[0]).toMatchObject({
      subjectRef: "svc:repo-1:apps/worker",
      subjectKind: "Service",
      objectRef: "stream:repo-1:apps/worker:SQS",
      objectKind: "Stream",
      predicate: "CONSUMES_FROM",
    })
  })

  it("maps role both to PRODUCES_TO and CONSUMES_FROM claims", () => {
    const streams: SubmittedStream[] = [
      { streamType: "Redis Pub/Sub", path: "apps/realtime", role: "both" },
    ]
    const { claims } = processStreamSubmissions(streams, {
      ...baseState,
      roots: ["apps/realtime"],
    })

    expect(claims).toHaveLength(2)
    const predicates = claims.map((c) => c.predicate).sort()
    expect(predicates).toEqual(["CONSUMES_FROM", "PRODUCES_TO"])
  })

  it("normalizes streamType for deduplication", () => {
    const streams: SubmittedStream[] = [
      { streamType: "kafka", path: "apps/web", role: "producer" },
      { streamType: "KAFKA", path: "apps/web", role: "consumer" },
    ]
    const { objects } = processStreamSubmissions(streams, baseState)

    expect(objects).toHaveLength(1)
    expect(objects[0].name).toBe("Kafka")
    expect(objects[0].deduplicationKey).toBe("stream:repo-1:apps/web:Kafka")
  })

  it("filters streams by pathMatchesRoot", () => {
    const streams: SubmittedStream[] = [
      { streamType: "NATS", path: "apps/web", role: "producer" },
      { streamType: "Pulsar", path: "other/monorepo", role: "consumer" },
    ]
    const { objects } = processStreamSubmissions(streams, {
      ...baseState,
      roots: ["apps/web"],
    })

    expect(objects).toHaveLength(1)
    expect(objects[0].name).toBe("NATS")
  })

  it("includes evidence in payload and provenance", () => {
    const streams: SubmittedStream[] = [
      {
        streamType: "Kafka",
        path: "apps/web",
        role: "producer",
        evidence: "confluent-kafka producer.send()",
      },
    ]
    const { objects, claims } = processStreamSubmissions(streams, baseState)

    expect(objects[0].payload).toMatchObject({
      streamType: "Kafka",
      path: "apps/web",
      submittedPath: "apps/web",
      evidence: "confluent-kafka producer.send()",
    })
    expect(claims[0].provenance).toMatchObject({
      root: "apps/web",
      streamType: "Kafka",
      evidence: "confluent-kafka producer.send()",
    })
  })

  it("sets sourceId with targetHash for traceability", () => {
    const streams: SubmittedStream[] = [
      { streamType: "Kafka", path: "apps/web", role: "producer" },
    ]
    const { claims } = processStreamSubmissions(streams, baseState)

    expect(claims[0].sourceId).toContain(
      "identifyStreams:repo-1:apps/web:Kafka:PRODUCES_TO:abc123",
    )
  })
})
