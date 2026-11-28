import * as cdk from "aws-cdk-lib"
import { Template } from "aws-cdk-lib/assertions"
import { describe, expect, it } from "vitest"

import {
  knownFindings,
  sampleValue,
  SERVICES,
  serviceFindings,
} from "../../../apps/backend/src/config/deploy-env-contract"
import { CtxPipe } from "./ctxpipe"
import type { CtxPipeSize } from "./types"

const secret = (value: string) => cdk.SecretValue.unsafePlainText(value)

/**
 * The env of each container of a `CtxPipe` synth with each optional setting
 * given. A Secrets Manager reference or a CloudFormation intrinsic is set:
 * it gets a sample value, because its value comes at deploy.
 */
function taskEnvironments(
  size: CtxPipeSize,
  modelKind: "openai-like" | "bedrock",
): Record<string, Record<string, string>> {
  const app = new cdk.App()
  const stack = new cdk.Stack(app, "EnvContract", {
    env: { account: "123456789012", region: "us-east-1" },
  })
  new CtxPipe(stack, "CtxPipe", {
    orgSlug: "acme",
    size,
    customDomain: {
      domainName: "app.example.com",
      hostedZoneId: "Z0123456789ABCDEF",
    },
    modelProvider:
      modelKind === "bedrock"
        ? { kind: "bedrock", models: { fast: "openai.gpt-5.5" } }
        : {
            kind: "openai-like",
            baseUrl: "https://openrouter.ai/api/v1",
            apiKey: secret("model-key"),
            models: { fast: "openai/gpt-6-luna" },
          },
    connectorSecrets: {
      githubAppId: secret("github-app-id"),
      githubPrivateKey: secret("github-private-key"),
      githubWebhookSecret: secret("github-webhook-secret"),
      githubClientId: secret("github-client-id"),
      githubClientSecret: secret("github-client-secret"),
      atlassianClientId: secret("atlassian-client-id"),
      atlassianClientSecret: secret("atlassian-client-secret"),
      slackClientId: secret("slack-client-id"),
      slackClientSecret: secret("slack-client-secret"),
      slackSigningSecret: secret("slack-signing-secret"),
      linearClientId: secret("linear-client-id"),
      linearClientSecret: secret("linear-client-secret"),
      linearRedirectUri: secret("https://app.example.com/linear"),
      linearWebhookSecret: secret("linear-webhook-secret"),
      notionClientId: secret("notion-client-id"),
      notionClientSecret: secret("notion-client-secret"),
      notionWebhookSecret: secret("notion-webhook-secret"),
      pagerdutyClientId: secret("pagerduty-client-id"),
      pagerdutyClientSecret: secret("pagerduty-client-secret"),
      pagerdutyRedirectUri: secret("https://app.example.com/pagerduty"),
    },
    otel: {
      endpoint: "https://otel.example.com",
      headers: secret("Authorization=Bearer token"),
      resourceAttributes: "deployment.environment=production",
    },
  })
  const environments: Record<string, Record<string, string>> = {}
  const taskDefinitions = Template.fromStack(stack).findResources(
    "AWS::ECS::TaskDefinition",
  )
  for (const resource of Object.values(taskDefinitions)) {
    const containers = (
      resource.Properties as {
        ContainerDefinitions?: Array<{
          Name: string
          Environment?: Array<{ Name: string; Value: unknown }>
          Secrets?: Array<{ Name: string }>
        }>
      }
    ).ContainerDefinitions
    for (const container of containers ?? []) {
      const env: Record<string, string> = {}
      for (const { Name, Value } of container.Environment ?? [])
        env[Name] = typeof Value === "string" ? Value : sampleValue(Name)
      for (const { Name } of container.Secrets ?? [])
        env[Name] = sampleValue(Name)
      environments[container.Name] = env
    }
  }
  return environments
}

describe("the env contract of the construct", () => {
  it(
    "gives each task the settings that it needs, for each size and model kind, except the known gaps",
    { timeout: 120_000 },
    () => {
      const found = new Set<string>()
      for (const size of ["small", "medium", "large"] as const)
        for (const modelKind of ["openai-like", "bedrock"] as const) {
          const containers = taskEnvironments(size, modelKind)
          for (const service of SERVICES) {
            const env = containers[service]
            if (!env) found.add(`construct ${service}: no container`)
            else
              for (const finding of serviceFindings(
                "construct",
                service,
                env,
                modelKind,
              ))
                found.add(finding)
          }
        }
      // A new finding: fix the construct. A known finding that is gone:
      // remove it from KNOWN_GAPS in deploy-env-contract.ts.
      expect([...found].sort()).toEqual(knownFindings("construct"))
    },
  )
})
