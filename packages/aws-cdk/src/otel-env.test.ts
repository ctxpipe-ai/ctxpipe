import * as cdk from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import { CtxPipe } from "./ctxpipe";

function synth(otel?: ConstructorParameters<typeof CtxPipe>[2]["otel"]): Template {
  const app = new cdk.App();
  const stack = new cdk.Stack(app, "TestStack", {
    env: { account: "123456789012", region: "us-east-1" },
  });
  new CtxPipe(stack, "CtxPipe", {
    orgSlug: "acme",
    customDomain: {
      domainName: "app.example.com",
      hostedZoneId: "Z0123456789ABCDEF",
    },
    modelProvider: {
      kind: "bedrock",
      models: { fast: "openai.gpt-5.5" },
    },
    ...(otel ? { otel } : {}),
  });
  return Template.fromStack(stack);
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
        Secrets?: Array<{ Name: string }>;
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

function containerSecretNames(template: Template, containerName: string): string[] {
  const resources = template.findResources("AWS::ECS::TaskDefinition");
  for (const resource of Object.values(resources)) {
    const properties = resource.Properties as {
      ContainerDefinitions?: Array<{
        Name?: string;
        Secrets?: Array<{ Name: string }>;
      }>;
    };
    const container = properties.ContainerDefinitions?.find(
      (candidate) => candidate.Name === containerName,
    );
    if (container) {
      return (container.Secrets ?? []).map((entry) => entry.Name);
    }
  }
  throw new Error(`${containerName} container not found`);
}

describe("CtxPipe OpenTelemetry env", () => {
  it("sets no OTEL env and no collector when otel is omitted", () => {
    const template = synth();
    const resources = template.findResources("AWS::ECS::TaskDefinition");
    for (const resource of Object.values(resources)) {
      const properties = resource.Properties as {
        ContainerDefinitions?: Array<{
          Environment?: Array<{ Name: string }>;
        }>;
      };
      for (const container of properties.ContainerDefinitions ?? []) {
        for (const entry of container.Environment ?? []) {
          expect(entry.Name.startsWith("OTEL_")).toBe(false);
        }
      }
    }
    const descriptions = JSON.stringify(template.toJSON());
    expect(descriptions).not.toContain("telemetry.ctxpipe.ai");
    expect(descriptions).not.toContain("langfuse.ctxpipe.ai");
    expect(descriptions).not.toContain("otel-collector");
  });

  it("passes standard OTLP env to app tasks when otel is set", () => {
    const template = synth({
      tracesEndpoint: "https://otel.example.com/v1/traces",
      logsEndpoint: "https://otel.example.com/v1/logs",
      metricsEndpoint: "https://otel.example.com/v1/metrics",
      headers: cdk.SecretValue.unsafePlainText("Authorization=Bearer collector"),
      resourceAttributes: "deployment.environment=production",
    });

    expect(containerEnvironment(template, "backend")).toMatchObject({
      OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "https://otel.example.com/v1/traces",
      OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: "https://otel.example.com/v1/logs",
      OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: "https://otel.example.com/v1/metrics",
      OTEL_RESOURCE_ATTRIBUTES: "deployment.environment=production",
      OTEL_SERVICE_NAME: "backend",
    });
    expect(containerEnvironment(template, "worker").OTEL_SERVICE_NAME).toBe(
      "openworkflow",
    );
    expect(containerEnvironment(template, "ui").OTEL_SERVICE_NAME).toBe("ui");
    expect(containerEnvironment(template, "codesearch").OTEL_SERVICE_NAME).toBe(
      "codesearch",
    );
    expect(containerSecretNames(template, "backend")).toContain(
      "OTEL_EXPORTER_OTLP_HEADERS",
    );
    expect(containerSecretNames(template, "ui")).toContain(
      "OTEL_EXPORTER_OTLP_HEADERS",
    );
    expect(containerSecretNames(template, "migrate")).not.toContain(
      "OTEL_EXPORTER_OTLP_HEADERS",
    );
    expect(containerEnvironment(template, "migrate").OTEL_SERVICE_NAME).toBeUndefined();
  });
});
