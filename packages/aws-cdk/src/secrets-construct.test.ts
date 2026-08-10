import * as cdk from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import { CtxPipe } from "./ctxpipe";
import type { CtxPipeConnectorSecretsProps } from "./types";

function synthCtxPipe(connectorSecrets?: CtxPipeConnectorSecretsProps): Template {
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
    connectorSecrets,
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

  it("injects Linear connector settings into backend and worker tasks", () => {
    const template = synthCtxPipe({
      linearClientId: cdk.SecretValue.unsafePlainText("linear-client"),
      linearClientSecret: cdk.SecretValue.unsafePlainText("linear-secret"),
      linearRedirectUri: cdk.SecretValue.unsafePlainText(
        "https://app.example.com/api/v1/integrations/linear/callback",
      ),
      linearWebhookSecret: cdk.SecretValue.unsafePlainText("webhook-secret"),
    });
    const taskDefinitions = Object.values(
      template.findResources("AWS::ECS::TaskDefinition"),
    );

    for (const variable of [
      "LINEAR_CLIENT_ID",
      "LINEAR_CLIENT_SECRET",
      "LINEAR_REDIRECT_URI",
      "LINEAR_WEBHOOK_SECRET",
    ]) {
      expect(
        taskDefinitions.filter((definition) =>
          JSON.stringify(definition).includes(variable),
        ),
      ).toHaveLength(2);
    }
  });
});

describe("SecretsConstruct connector secrets", () => {
  it("injects Notion OAuth and webhook secrets into service tasks", () => {
    const template = synthCtxPipe({
      notionClientId: cdk.SecretValue.unsafePlainText("notion-client-id"),
      notionClientSecret: cdk.SecretValue.unsafePlainText("notion-client-secret"),
      notionWebhookSecret: cdk.SecretValue.unsafePlainText("notion-webhook-secret"),
    });

    for (const name of [
      "NOTION_CLIENT_ID",
      "NOTION_CLIENT_SECRET",
      "NOTION_WEBHOOK_SECRET",
    ]) {
      template.hasResourceProperties("AWS::ECS::TaskDefinition", {
        ContainerDefinitions: Match.arrayWith([
          Match.objectLike({
            Secrets: Match.arrayWith([
              Match.objectLike({
                Name: name,
                ValueFrom: Match.anyValue(),
              }),
            ]),
          }),
        ]),
      });
    }
  });
});
