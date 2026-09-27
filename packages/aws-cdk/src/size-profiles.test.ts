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
  throw new Error("codesearch task definition not found"  );
}

function containerEnvironment(
  template: Template,
  containerName: string,
): Record<string, string> {
  const resources = template.findResources("AWS::ECS::TaskDefinition");
  for (const resource of Object.values(resources)) {
    const properties = resource.Properties as {
      ContainerDefinitions?: Array<{
        Name?: string;
        Environment?: Array<{ Name: string; Value: string }>;
      }>;
    };
    const container = properties.ContainerDefinitions?.find(
      (candidate) => candidate.Name === containerName,
    );
    if (container) {
      return Object.fromEntries(
        (container.Environment ?? []).map((entry) => [entry.Name, entry.Value]),
      );
    }
  }
  throw new Error(`${containerName} container not found`);
}

function desiredCountForContainer(
  template: Template,
  containerName: string,
): number {
  const taskDefs = template.findResources("AWS::ECS::TaskDefinition");
  let taskDefLogicalId: string | undefined;
  for (const [id, resource] of Object.entries(taskDefs)) {
    const properties = resource.Properties as {
      ContainerDefinitions?: Array<{ Name?: string }>;
    };
    if (
      properties.ContainerDefinitions?.some(
        (container) => container.Name === containerName,
      )
    ) {
      taskDefLogicalId = id;
      break;
    }
  }
  if (!taskDefLogicalId) {
    throw new Error(`${containerName} task definition not found`);
  }
  const services = template.findResources("AWS::ECS::Service");
  for (const resource of Object.values(services)) {
    const properties = resource.Properties as {
      TaskDefinition?: { Ref?: string };
      DesiredCount?: number;
    };
    if (properties.TaskDefinition?.Ref === taskDefLogicalId) {
      return properties.DesiredCount ?? 0;
    }
  }
  throw new Error(`${containerName} service not found`);
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

describe("SIZE_PROFILES codesearch admission env", () => {
  it.each([
    ["small", "6", "1", "1", 1, 1],
    ["medium", "10", "2", "2", 1, 1],
    ["large", "8", "2", "2", 2, 1],
  ] as const)(
    "size %s injects worker concurrency %s indexer %s pipelines %s (workers %s, codesearch %s)",
    (
      size,
      openWorkflowConcurrency,
      indexerConcurrency,
      pipelineConcurrency,
      workerCount,
      codesearchCount,
    ) => {
      const template = synthForSize(size);
      const workerEnv = containerEnvironment(template, "worker");
      const codesearchEnv = containerEnvironment(template, "codesearch");
      expect(workerEnv.OPENWORKFLOW_CONCURRENCY).toBe(openWorkflowConcurrency);
      expect(workerEnv.CODESEARCH_INDEXER_CONCURRENCY).toBe(indexerConcurrency);
      expect(codesearchEnv.CODESEARCH_INDEXER_CONCURRENCY).toBe(
        indexerConcurrency,
      );
      expect(codesearchEnv.CODESEARCH_INDEX_PIPELINE_CONCURRENCY).toBe(
        pipelineConcurrency,
      );
      expect(desiredCountForContainer(template, "worker")).toBe(workerCount);
      expect(desiredCountForContainer(template, "codesearch")).toBe(
        codesearchCount,
      );
    },
  );
});
