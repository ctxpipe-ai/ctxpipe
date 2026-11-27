import * as cdk from "aws-cdk-lib"
import { Template } from "aws-cdk-lib/assertions"
import { describe, expect, it } from "vitest"

import { CtxPipe } from "./ctxpipe"

type WriterEvent = {
  RequestType: "Create" | "Update" | "Delete"
  PhysicalResourceId?: string
  ResourceProperties: Record<string, string>
}
type WriterResult = { PhysicalResourceId: string }

/** The secret values that the handler wrote, by secret ARN. */
const written = new Map<string, string>()

// Loads the inline handler from the synthesized template. Only the AWS SDK is faked.
function loadWriterHandler(): (event: WriterEvent) => Promise<WriterResult> {
  const app = new cdk.App()
  const stack = new cdk.Stack(app, "TestStack", {
    env: { account: "123456789012", region: "us-east-1" },
  })
  new CtxPipe(stack, "CtxPipe", {
    size: "small",
    customDomain: {
      domainName: "app.example.com",
      hostedZoneId: "Z0123456789ABCDEF",
    },
    modelProvider: { kind: "bedrock", models: { fast: "openai.gpt-5.5" } },
  })
  const functions = Template.fromStack(stack).findResources(
    "AWS::Lambda::Function",
  )
  const code = Object.values(functions)
    .map(
      (resource) =>
        (resource.Properties as { Code?: { ZipFile?: string } }).Code?.ZipFile,
    )
    .find((zipFile) => zipFile?.includes("WriterPhysicalId"))
  if (!code) throw new Error("DatabaseUrlWriter function code not found")

  class GetSecretValueCommand {}
  class PutSecretValueCommand {
    constructor(readonly input: { SecretId: string; SecretString: string }) {}
  }
  class FakeClient {
    async send(command: object) {
      if (command instanceof PutSecretValueCommand)
        written.set(command.input.SecretId, command.input.SecretString)
      return { SecretString: JSON.stringify({ password: "secret" }) }
    }
  }
  const fakeSdk = {
    SecretsManagerClient: FakeClient,
    GetSecretValueCommand,
    PutSecretValueCommand,
  }
  const exportsObject: {
    handler?: (event: WriterEvent) => Promise<WriterResult>
  } = {}
  new Function("require", "exports", code)(() => fakeSdk, exportsObject)
  if (!exportsObject.handler) throw new Error("handler not exported")
  return exportsObject.handler
}

const properties = {
  WriterPhysicalId: "database-url-writer",
  Username: "ctxpipe",
  DbCredentialsSecretArn: "arn:credentials",
  DatabaseUrlSecretArn: "arn:url",
  DbHost: "db.example.com",
  DbPort: "5432",
  DatabaseName: "ctxpipe",
}
const generatedId =
  "Stack-CtxPipeSecretsDatabaseUrlWriterE24FDFE7-1XJVGU8CM8MHK"

describe("DatabaseUrlWriter handler physical id", () => {
  it("keeps the stable id on Create", async () => {
    const result = await loadWriterHandler()({
      RequestType: "Create",
      ResourceProperties: properties,
    })
    expect(result.PhysicalResourceId).toBe("database-url-writer")
  })

  it("echoes the CloudFormation id on Delete", async () => {
    const result = await loadWriterHandler()({
      RequestType: "Delete",
      PhysicalResourceId: generatedId,
      ResourceProperties: properties,
    })
    expect(result.PhysicalResourceId).toBe(generatedId)
  })

  it("echoes the CloudFormation id on Update", async () => {
    const result = await loadWriterHandler()({
      RequestType: "Update",
      PhysicalResourceId: generatedId,
      ResourceProperties: properties,
    })
    expect(result.PhysicalResourceId).toBe(generatedId)
  })
})

describe("DatabaseUrlWriter handler URL", () => {
  it("writes the Postgres DATABASE_URL by default", async () => {
    await loadWriterHandler()({
      RequestType: "Create",
      ResourceProperties: properties,
    })
    expect(JSON.parse(written.get("arn:url") ?? "")).toEqual({
      DATABASE_URL: "postgresql://ctxpipe:secret@db.example.com:5432/ctxpipe",
    })
  })

  it("writes a ClickHouse CLICKHOUSE_URL with the scheme and key it gets", async () => {
    await loadWriterHandler()({
      RequestType: "Create",
      ResourceProperties: {
        ...properties,
        WriterPhysicalId: "ctxpipe_reader-clickhouse-url-writer",
        Scheme: "http",
        UrlKey: "CLICKHOUSE_URL",
        Username: "ctxpipe_reader",
        DatabaseUrlSecretArn: "arn:clickhouse-url",
        DbHost: "clickhouse.ctxpipe.local",
        DbPort: "8123",
      },
    })
    expect(JSON.parse(written.get("arn:clickhouse-url") ?? "")).toEqual({
      CLICKHOUSE_URL:
        "http://ctxpipe_reader:secret@clickhouse.ctxpipe.local:8123/ctxpipe",
    })
  })
})
