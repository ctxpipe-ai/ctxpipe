import * as cdk from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import { CtxPipe } from "./ctxpipe";

function synthCtxPipe(): Template {
  const app = new cdk.App();
  const stack = new cdk.Stack(app, "TestStack", {
    env: { account: "123456789012", region: "us-east-1" },
  });
  new CtxPipe(stack, "CtxPipe", {
    orgSlug: "acme",
    size: "small",
    customDomain: {
      domainName: "app.example.com",
      hostedZoneId: "Z0123456789ABCDEF",
    },
    modelProvider: {
      kind: "bedrock",
      models: { fast: "openai.gpt-5.5" },
    },
  });
  return Template.fromStack(stack);
}

function findResourceByIdFragment(
  resources: Record<string, unknown>,
  fragment: string,
): [string, Record<string, unknown>] | undefined {
  return Object.entries(resources).find(([logicalId]) => logicalId.includes(fragment)) as
    | [string, Record<string, unknown>]
    | undefined;
}

describe("SecretsConstruct database URL secret", () => {
  it("does not synthesize DATABASE_URL from the RDS credentials SecretValue", () => {
    const template = synthCtxPipe();
    const secrets = template.findResources("AWS::SecretsManager::Secret");
    const databaseUrlSecret = findResourceByIdFragment(secrets, "DatabaseUrlSecret");

    expect(databaseUrlSecret).toBeDefined();
    const properties = databaseUrlSecret?.[1].Properties as Record<string, unknown> | undefined;
    expect(properties).toBeDefined();
    expect(properties).not.toHaveProperty("SecretString");
    expect(properties?.SecretObject).toBeUndefined();
    const generateSecretString = properties?.GenerateSecretString as
      | Record<string, unknown>
      | undefined;
    expect(generateSecretString?.SecretStringTemplate ?? "").not.toContain("postgresql://");
    expect(JSON.stringify(generateSecretString ?? {})).not.toContain("password");
  });

  it("writes DATABASE_URL at deploy time via a custom resource", () => {
    const template = synthCtxPipe();
    template.hasResourceProperties("AWS::CloudFormation::CustomResource", {
      DbCredentialsSecretArn: Match.anyValue(),
      DatabaseUrlSecretArn: Match.anyValue(),
      DbHost: Match.anyValue(),
      DbPort: Match.anyValue(),
      DatabaseName: "ctxpipe",
    });
  });

  it("runs migrations only after the database URL writer completes", () => {
    const template = synthCtxPipe();
    const customResources = template.findResources("AWS::CloudFormation::CustomResource");
    const migrateResource = findResourceByIdFragment(customResources, "RunMigrations");
    const databaseUrlWriter = findResourceByIdFragment(customResources, "DatabaseUrlWriter");

    expect(migrateResource).toBeDefined();
    expect(databaseUrlWriter).toBeDefined();

    const dependsOn = migrateResource?.[1].DependsOn;
    expect(dependsOn).toBeDefined();
    const dependsOnList = Array.isArray(dependsOn) ? dependsOn : [dependsOn];
    expect(dependsOnList).toEqual(
      expect.arrayContaining([databaseUrlWriter?.[0]]),
    );
  });
});
