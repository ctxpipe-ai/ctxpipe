import * as cdk from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import { CtxPipe } from "./ctxpipe";
import type { CtxPipeSize } from "./types";

function synthForSize(size: CtxPipeSize): Template {
  const app = new cdk.App();
  const stack = new cdk.Stack(app, "TestStack", {
    env: { account: "123456789012", region: "us-east-1" },
  });
  new CtxPipe(stack, "CtxPipe", {
    orgSlug: "acme",
    size,
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

function neptuneInstanceClasses(template: Template): string[] {
  const resources = template.findResources("AWS::Neptune::DBInstance");
  return Object.values(resources).map(
    (resource) =>
      (resource.Properties as { DBInstanceClass?: string }).DBInstanceClass ??
      "",
  );
}

function codesearchTaskCpuMemory(template: Template): {
  cpu: string;
  memory: string;
} {
  const resources = template.findResources("AWS::ECS::TaskDefinition");
  for (const resource of Object.values(resources)) {
    const properties = resource.Properties as {
      Cpu?: string;
      Memory?: string;
      ContainerDefinitions?: Array<{ Name?: string }>;
    };
    const hasCodesearch = properties.ContainerDefinitions?.some(
      (container) => container.Name === "codesearch",
    );
    if (hasCodesearch) {
      return {
        cpu: properties.Cpu ?? "",
        memory: properties.Memory ?? "",
      };
    }
  }
  throw new Error("codesearch task definition not found");
}

describe("SIZE_PROFILES database instance classes", () => {
  it.each([
    ["small", "db.t4g.medium", "db.t4g.medium"],
    ["medium", "db.t4g.large", "db.r6g.large"],
    ["large", "db.r6g.xlarge", "db.r6g.xlarge"],
  ] as const)(
    "size %s uses Aurora %s and Neptune %s",
    (size, auroraClass, neptuneClass) => {
      const template = synthForSize(size);
      template.hasResourceProperties("AWS::RDS::DBInstance", {
        DBInstanceClass: auroraClass,
      });
      template.hasResourceProperties("AWS::Neptune::DBInstance", {
        DBInstanceClass: neptuneClass,
      });
    },
  );

  it("does not synthesize unsupported Neptune db.t4g.large or db.t4g.xlarge", () => {
    for (const size of ["small", "medium", "large"] as const) {
      const classes = neptuneInstanceClasses(synthForSize(size));
      for (const dbClass of classes) {
        expect(dbClass).not.toMatch(/^db\.t4g\.(large|xlarge)$/);
      }
    }
  });
});

describe("SIZE_PROFILES codesearch task size", () => {
  it.each([
    ["small", "512", "4096"],
    ["medium", "1024", "8192"],
    ["large", "2048", "12288"],
  ] as const)(
    "size %s uses codesearch cpu %s memory %s",
    (size, cpu, memory) => {
      expect(codesearchTaskCpuMemory(synthForSize(size))).toEqual({
        cpu,
        memory,
      });
    },
  );
});
