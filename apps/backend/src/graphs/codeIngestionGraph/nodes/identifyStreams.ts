/**
 * identifyStreams – Extracts message/event stream usage from a codebase.
 *
 * Detects Kafka, RabbitMQ, SQS, SNS, Redis Pub/Sub, NATS, Pulsar, and similar
 * streaming/messaging systems. Produces Stream objects and PRODUCES_TO /
 * CONSUMES_FROM claims linking Service nodes to Stream nodes.
 *
 * @module codeIngestionGraph/nodes/identifyStreams
 */

import { HumanMessage } from "@langchain/core/messages"
import { tool } from "langchain"
import { z } from "zod/v3"
import { requireCurrentOrgId } from "../../../auth/context.js"
import { langfusePipelineCallbacks } from "../../../observability/langfusePipelineMetrics.js"
import { getLogger } from "../../../observability/logger.js"
import { getModel } from "../../../retrieval/services/modelProvider.js"
import {
  REPO_EXPLORER_TOOLS_HINT,
  standardRepoExplorerTools,
} from "../../../tools/repoExplorerTools.js"
import { createAgent } from "../../createAgent.js"
import type { CodeIngestionState } from "../schemas.js"
import {
  processStreamSubmissions,
  type SubmittedStream,
} from "./identifyStreamsProcess.js"
import {
  partialScanPathsForExtractors,
  partialScanPromptSuffix,
  repoPathMatchesPartialScan,
  shouldSkipExtractorForPartialDeletesOnly,
} from "./partialIngestionScope.js"

function createIdentifyStreamsTools(capturedStreams: {
  value: SubmittedStream[]
}) {
  const submitStreamsTool = tool(
    async ({ streams }) => {
      capturedStreams.value.push(...streams)
      return `Recorded ${streams.length} stream(s). Total: ${capturedStreams.value.length}.`
    },
    {
      name: "submit_streams",
      description: `Call this when you have discovered one or more message/event streams used by the codebase. For each stream provide streamType (e.g. Kafka, RabbitMQ, SQS, SNS, Redis Pub/Sub, NATS, Pulsar), path (root or directory where it's used), role (producer, consumer, or both), and optional evidence.`,
      schema: z.object({
        streams: z.array(
          z.object({
            streamType: z
              .string()
              .describe(
                "Stream type: Kafka, RabbitMQ, SQS, SNS, Redis Pub/Sub, NATS, Pulsar, Google Pub/Sub, Azure Event Hubs, ActiveMQ, etc.",
              ),
            path: z
              .string()
              .describe(
                "Root or directory path where stream is used, e.g. apps/web or .",
              ),
            role: z
              .enum(["producer", "consumer", "both"])
              .describe(
                "Whether the service produces to, consumes from, or both produces and consumes the stream",
              ),
            evidence: z
              .string()
              .optional()
              .describe("Brief evidence, e.g. kafka-python producer.send()"),
          }),
        ),
      }),
    },
  )
  return [...standardRepoExplorerTools, submitStreamsTool]
}

const SYSTEM_PROMPT = `You are analyzing a repository to detect all message/event streams and messaging systems used by the codebase. Look across any language — JavaScript, TypeScript, Python, Go, Java, Kotlin, Ruby, PHP, C#, Rust, Elixir, and others. Do not assume a single stack.

Stream types and detection hints:
| Stream type      | Detection hints |
| -----------------| -----------------|
| Kafka            | kafka-python, confluent-kafka, @nestjs/microservices (Kafka transport), sarama, kafkajs, node-rdkafka, aiokafka |
| RabbitMQ         | amqp, pika, amqplib, @golevelup/nestjs-rabbitmq, spring-amqp |
| AWS SQS          | @aws-sdk/client-sqs, boto3 sqs, receive_message, send_message |
| AWS SNS          | @aws-sdk/client-sns, boto3 sns, publish, subscribe |
| Redis Pub/Sub    | ioredis publish/subscribe, redis-py pubsub, redis.subscribe, redis.publish |
| NATS             | nats.js, nats.go, nats-py, JetStream |
| Pulsar           | pulsar-client, @apache/pulsar-client-node |
| Google Pub/Sub   | @google-cloud/pubsub, google-cloud-pubsub |
| Azure Event Hubs | @azure/event-hubs, azure-eventhub |
| ActiveMQ         | stomp.js, activemq, @stomp/stompjs |

Search strategy:
1. list_files at each root for package.json, requirements.txt, pyproject.toml, go.mod, pom.xml, Cargo.toml
2. search for stream/messaging imports and usage: kafka, rabbitmq, sqs, sns, redis publish, nats, pulsar
3. get_file on manifest files and source files to confirm producer vs consumer usage
4. For producer: look for send, publish, produce, put
5. For consumer: look for subscribe, consume, receive, get

For each stream found, call submit_streams with streamType, path (root or directory), role (producer/consumer/both), and optional evidence. Be thorough. Explore all roots. Prefer submit_streams once dependency/import evidence is clear.`

export async function identifyStreams(
  state: CodeIngestionState,
): Promise<Partial<CodeIngestionState>> {
  const { repositoryId, roots = ["./"], targetHash } = state
  requireCurrentOrgId()

  if (shouldSkipExtractorForPartialDeletesOnly(state)) {
    return {}
  }

  const scanPaths = partialScanPathsForExtractors(state)
  const scopeHint =
    state.ingestMode === "partial" && scanPaths.length > 0
      ? partialScanPromptSuffix(scanPaths)
      : ""

  const capturedStreams: { value: SubmittedStream[] } = { value: [] }
  const tools = createIdentifyStreamsTools(capturedStreams)
  const agent = createAgent({
    model: getModel("medium", { temperature: 0.1 }),
    tools,
    contextMiddleware: {
      clearToolUsesTriggerTokens: 140_000,
      clearToolUsesKeepMessages: 14,
      summarizationTriggerTokens: 220_000,
      summarizationKeepMessages: 32,
    },
    systemPrompt: `${SYSTEM_PROMPT}

Use repositoryId "${repositoryId}" for all tool calls. Roots to explore: ${roots.join(", ")}.

${REPO_EXPLORER_TOOLS_HINT}${scopeHint}`,
  })

  const userMessage = `Explore the repository for message/event streams. List files in config directories, search for Kafka, RabbitMQ, SQS, SNS, Redis Pub/Sub, NATS, Pulsar and similar patterns across all languages. For each stream found, determine if the service produces to, consumes from, or both. Call submit_streams with streamType, path, role, and optional evidence.`

  await agent.invoke(
    { messages: [new HumanMessage(userMessage)] },
    {
      recursionLimit: 180,
      callbacks: langfusePipelineCallbacks({
        step: "codeIngestion.identifyStreams",
        dimensions: { repositoryId, targetHash },
      }),
    },
  )

  if (capturedStreams.value.length === 0) {
    getLogger().warn(
      "identifyStreams: agent completed without submit_streams (no streams captured)",
      { repositoryId, targetHash },
    )
  }

  let submissions = capturedStreams.value
  if (state.ingestMode === "partial" && scanPaths.length > 0) {
    submissions = submissions.filter((s) =>
      repoPathMatchesPartialScan(s.path, scanPaths),
    )
  }

  const { objects: processedObjects, claims: processedClaims } =
    processStreamSubmissions(submissions, {
      repositoryId,
      roots,
      targetHash,
    })

  return {
    extractedObjects: processedObjects,
    extractedClaims: processedClaims,
  }
}
