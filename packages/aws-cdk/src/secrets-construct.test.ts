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
  exclude?: string,
): [string, Record<string, unknown>] | undefined {
  return Object.entries(resources).find(
    ([logicalId]) =>
      logicalId.includes(fragment) && (exclude === undefined || !logicalId.includes(exclude)),
  ) as [string, Record<string, unknown>] | undefined;
}

describe("SecretsConstruct database URL secret", () => {
  it("does not synthesize DATABASE_URL from the RDS credentials SecretValue", () => {
    const template = synthCtxPipe();
    const secrets = template.findResources("AWS::SecretsManager::Secret");
    const databaseUrlSecret = findResourceByIdFragment(
      secrets,
      "DatabaseUrlSecret",
      "Owner",
    );

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

  it("generates the ctxpipe_app password once in Secrets Manager", () => {
    const template = synthCtxPipe();
    const secrets = template.findResources("AWS::SecretsManager::Secret");
    const appCredentials = findResourceByIdFragment(secrets, "AppDatabaseCredentialsSecret");
    expect(appCredentials).toBeDefined();
    const properties = appCredentials?.[1].Properties as Record<string, unknown> | undefined;
    const generateSecretString = properties?.GenerateSecretString as
      | Record<string, unknown>
      | undefined;
    expect(generateSecretString?.GenerateStringKey).toBe("password");
    expect(generateSecretString?.ExcludePunctuation).toBe(true);
    expect(String(generateSecretString?.SecretStringTemplate)).toContain("ctxpipe_app");
  });

  it("writes owner and runtime DATABASE_URL at deploy time via custom resources", () => {
    const template = synthCtxPipe();
    template.hasResourceProperties("AWS::CloudFormation::CustomResource", {
      Username: "ctxpipe",
      DatabaseName: "ctxpipe",
      DbCredentialsSecretArn: Match.anyValue(),
      DatabaseUrlSecretArn: Match.anyValue(),
      DbHost: Match.anyValue(),
      DbPort: Match.anyValue(),
    });
    template.hasResourceProperties("AWS::CloudFormation::CustomResource", {
      Username: "ctxpipe_app",
      DatabaseName: "ctxpipe",
      DbCredentialsSecretArn: Match.anyValue(),
      DatabaseUrlSecretArn: Match.anyValue(),
      DbHost: Match.anyValue(),
      DbPort: Match.anyValue(),
    });
  });

  it("runs migrations only after the owner database URL writer completes", () => {
    const template = synthCtxPipe();
    const customResources = template.findResources("AWS::CloudFormation::CustomResource");
    const migrateResource = findResourceByIdFragment(customResources, "RunMigrations");
    const ownerUrlWriter = findResourceByIdFragment(
      customResources,
      "DatabaseUrlWriter",
      "Runtime",
    );

    expect(migrateResource).toBeDefined();
    expect(ownerUrlWriter).toBeDefined();

    const dependsOn = migrateResource?.[1].DependsOn;
    expect(dependsOn).toBeDefined();
    const dependsOnList = Array.isArray(dependsOn) ? dependsOn : [dependsOn];
    expect(dependsOnList).toEqual(expect.arrayContaining([ownerUrlWriter?.[0]]));
  });

  it("rewrites the runtime DATABASE_URL after migrate completes", () => {
    const template = synthCtxPipe();
    const customResources = template.findResources("AWS::CloudFormation::CustomResource");
    const migrateResource = findResourceByIdFragment(customResources, "RunMigrations");
    const runtimeWriter = findResourceByIdFragment(customResources, "RuntimeDatabaseUrlWriter");

    expect(migrateResource).toBeDefined();
    expect(runtimeWriter).toBeDefined();

    const dependsOn = runtimeWriter?.[1].DependsOn;
    const dependsOnList = Array.isArray(dependsOn) ? dependsOn : [dependsOn];
    expect(dependsOnList).toEqual(expect.arrayContaining([migrateResource?.[0]]));
  });

  it("injects owner DATABASE_URL and ctxpipe_app password into the migrate task only", () => {
    const template = synthCtxPipe();
    const taskDefinitions = Object.entries(template.findResources("AWS::ECS::TaskDefinition"));
    const migrateTask = taskDefinitions.find(([, resource]) =>
      JSON.stringify(resource).includes("ctxpipe-migrate"),
    );
    expect(migrateTask).toBeDefined();
    const migrateJson = JSON.stringify(migrateTask?.[1]);
    expect(migrateJson).toContain("DATABASE_APP_PASSWORD");
    expect(migrateJson).toContain("DATABASE_URL");

    const backendTask = taskDefinitions.find(([, resource]) =>
      JSON.stringify(resource).includes("ctxpipe-backend"),
    );
    expect(backendTask).toBeDefined();
    const backendJson = JSON.stringify(backendTask?.[1]);
    expect(backendJson).toContain("DATABASE_URL");
    expect(backendJson).not.toContain("DATABASE_APP_PASSWORD");
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
