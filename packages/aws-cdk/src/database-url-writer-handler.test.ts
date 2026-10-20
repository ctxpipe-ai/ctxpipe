import * as cdk from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import { CtxPipe } from "./ctxpipe";

type WriterEvent = {
  RequestType: "Create" | "Update" | "Delete";
  PhysicalResourceId?: string;
  ResourceProperties: Record<string, string>;
};
type WriterResult = { PhysicalResourceId: string };

// Loads the inline handler from the synthesized template. Only the AWS SDK is faked.
function loadWriterHandler(): (event: WriterEvent) => Promise<WriterResult> {
  const app = new cdk.App();
  const stack = new cdk.Stack(app, "TestStack", {
    env: { account: "123456789012", region: "us-east-1" },
  });
  new CtxPipe(stack, "CtxPipe", {
    orgSlug: "acme",
    size: "small",
    customDomain: { domainName: "app.example.com", hostedZoneId: "Z0123456789ABCDEF" },
    modelProvider: { kind: "bedrock", models: { fast: "openai.gpt-5.5" } },
  });
  const functions = Template.fromStack(stack).findResources("AWS::Lambda::Function");
  const code = Object.values(functions)
    .map((resource) => (resource.Properties as { Code?: { ZipFile?: string } }).Code?.ZipFile)
    .find((zipFile) => zipFile?.includes("WriterPhysicalId"));
  if (!code) throw new Error("DatabaseUrlWriter function code not found");

  class FakeCommand {}
  class FakeClient {
    async send() {
      return { SecretString: JSON.stringify({ password: "secret" }) };
    }
  }
  const fakeSdk = {
    SecretsManagerClient: FakeClient,
    GetSecretValueCommand: FakeCommand,
    PutSecretValueCommand: FakeCommand,
  };
  const exportsObject: { handler?: (event: WriterEvent) => Promise<WriterResult> } = {};
  new Function("require", "exports", code)(() => fakeSdk, exportsObject);
  if (!exportsObject.handler) throw new Error("handler not exported");
  return exportsObject.handler;
}

const properties = {
  WriterPhysicalId: "database-url-writer",
  Username: "ctxpipe",
  DbCredentialsSecretArn: "arn:credentials",
  DatabaseUrlSecretArn: "arn:url",
  DbHost: "db.example.com",
  DbPort: "5432",
  DatabaseName: "ctxpipe",
};
const generatedId = "Stack-CtxPipeSecretsDatabaseUrlWriterE24FDFE7-1XJVGU8CM8MHK";

describe("DatabaseUrlWriter handler physical id", () => {
  it("keeps the stable id on Create", async () => {
    const result = await loadWriterHandler()({
      RequestType: "Create",
      ResourceProperties: properties,
    });
    expect(result.PhysicalResourceId).toBe("database-url-writer");
  });

  it("echoes the CloudFormation id on Delete", async () => {
    const result = await loadWriterHandler()({
      RequestType: "Delete",
      PhysicalResourceId: generatedId,
      ResourceProperties: properties,
    });
    expect(result.PhysicalResourceId).toBe(generatedId);
  });

  it("echoes the CloudFormation id on Update", async () => {
    const result = await loadWriterHandler()({
      RequestType: "Update",
      PhysicalResourceId: generatedId,
      ResourceProperties: properties,
    });
    expect(result.PhysicalResourceId).toBe(generatedId);
  });
});
