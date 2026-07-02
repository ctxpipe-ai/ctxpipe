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

describe("Codesearch EFS mount", () => {
  it("creates an EFS access point with explicit root directory ACL", () => {
    const template = synthCtxPipe();
    template.hasResourceProperties("AWS::EFS::AccessPoint", {
      RootDirectory: {
        Path: "/codesearch",
        CreationInfo: {
          OwnerUid: "1000",
          OwnerGid: "1000",
          Permissions: "755",
        },
      },
      PosixUser: {
        Uid: "1000",
        Gid: "1000",
      },
    });
  });

  it("mounts codesearch EFS through the access point with IAM authorization", () => {
    const template = synthCtxPipe();
    template.hasResourceProperties("AWS::ECS::TaskDefinition", {
      Volumes: Match.arrayWith([
        Match.objectLike({
          Name: "codesearch-data",
          EFSVolumeConfiguration: Match.objectLike({
            TransitEncryption: "ENABLED",
            AuthorizationConfig: Match.objectLike({
              IAM: "ENABLED",
              AccessPointId: Match.anyValue(),
            }),
          }),
        }),
      ]),
    });
  });

  it("grants codesearch task role EFS client permissions scoped to the access point", () => {
    const template = synthCtxPipe();
    const policies = template.findResources("AWS::IAM::Policy");
    const codesearchTaskPolicy = Object.values(policies).find((resource) => {
      const policyName = (resource.Properties as { PolicyName?: string }).PolicyName ?? "";
      return policyName.includes("CodesearchTaskTaskRoleDefaultPolicy");
    });

    expect(codesearchTaskPolicy).toBeDefined();
    const statements = (
      codesearchTaskPolicy?.Properties as {
        PolicyDocument?: { Statement?: Array<Record<string, unknown>> };
      }
    ).PolicyDocument?.Statement;
    const accessPointScopedStatement = statements?.find((statement) => {
      const condition = statement.Condition as
        | { StringEquals?: Record<string, unknown> }
        | undefined;
      return (
        Array.isArray(statement.Action) &&
        statement.Action.includes("elasticfilesystem:ClientMount") &&
        statement.Action.includes("elasticfilesystem:ClientWrite") &&
        condition?.StringEquals?.["elasticfilesystem:AccessPointArn"] !== undefined
      );
    });

    expect(accessPointScopedStatement).toBeDefined();
  });

  it("waits for EFS mount targets before starting codesearch service", () => {
    const template = synthCtxPipe();
    const services = template.findResources("AWS::ECS::Service");
    const codesearchService = findResourceByIdFragment(services, "CodesearchService");
    const mountTargets = Object.keys(template.findResources("AWS::EFS::MountTarget"));

    expect(codesearchService).toBeDefined();
    expect(mountTargets.length).toBeGreaterThan(0);

    const dependsOn = codesearchService?.[1].DependsOn;
    expect(dependsOn).toBeDefined();
    const dependsOnList = Array.isArray(dependsOn) ? dependsOn : [dependsOn];
    expect(dependsOnList).toEqual(expect.arrayContaining(mountTargets));
  });
});
