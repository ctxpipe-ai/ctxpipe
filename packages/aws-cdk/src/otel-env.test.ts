import * as cdk from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { describe, it } from "vitest";
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

function expectNoOtelExport(template: Template): void {
  const noOtelName = Match.not(
    Match.arrayWith([
      Match.objectLike({
        Environment: Match.arrayWith([
          Match.objectLike({ Name: Match.stringLikeRegexp("^OTEL_") }),
        ]),
      }),
    ]),
  );
  const noOtelHeader = Match.not(
    Match.arrayWith([
      Match.objectLike({
        Secrets: Match.arrayWith([
          Match.objectLike({ Name: "OTEL_EXPORTER_OTLP_HEADERS" }),
        ]),
      }),
    ]),
  );
  template.allResourcesProperties("AWS::ECS::TaskDefinition", {
    ContainerDefinitions: noOtelName,
  });
  template.allResourcesProperties("AWS::ECS::TaskDefinition", {
    ContainerDefinitions: noOtelHeader,
  });
}

function expectOtelExport(template: Template, containerName: string, serviceName: string): void {
  template.hasResourceProperties("AWS::ECS::TaskDefinition", {
    ContainerDefinitions: Match.arrayWith([
      Match.objectLike({
        Name: containerName,
        Environment: Match.arrayWith([
          Match.objectLike({
            Name: "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT",
            Value: "https://otel.example.com/v1/traces",
          }),
          Match.objectLike({
            Name: "OTEL_EXPORTER_OTLP_LOGS_ENDPOINT",
            Value: "https://otel.example.com/v1/logs",
          }),
          Match.objectLike({
            Name: "OTEL_EXPORTER_OTLP_METRICS_ENDPOINT",
            Value: "https://otel.example.com/v1/metrics",
          }),
          Match.objectLike({
            Name: "OTEL_RESOURCE_ATTRIBUTES",
            Value: "deployment.environment=production",
          }),
          Match.objectLike({ Name: "OTEL_SERVICE_NAME", Value: serviceName }),
        ]),
        Secrets: Match.arrayWith([
          Match.objectLike({ Name: "OTEL_EXPORTER_OTLP_HEADERS" }),
        ]),
      }),
    ]),
  });
}

describe("CtxPipe OpenTelemetry env", () => {
  it("sets no OTEL env when otel is omitted", () => {
    expectNoOtelExport(synth());
  });

  it("sets no OTEL env when endpoint is blank", () => {
    expectNoOtelExport(
      synth({
        endpoint: "   ",
        headers: cdk.SecretValue.unsafePlainText("Authorization=Bearer collector"),
        resourceAttributes: "deployment.environment=production",
      }),
    );
  });

  it("expands one endpoint base onto the app tasks", () => {
    const template = synth({
      endpoint: "https://otel.example.com/",
      headers: cdk.SecretValue.unsafePlainText("Authorization=Bearer collector"),
      resourceAttributes: "  deployment.environment=production  ",
    });

    expectOtelExport(template, "backend", "backend");
    expectOtelExport(template, "worker", "openworkflow");
    expectOtelExport(template, "ui", "ui");
    expectOtelExport(template, "codesearch", "codesearch");
    template.hasResourceProperties("AWS::ECS::TaskDefinition", {
      ContainerDefinitions: Match.arrayWith([
        Match.objectLike({
          Name: "migrate",
          Environment: Match.absent(),
          Secrets: Match.not(
            Match.arrayWith([
              Match.objectLike({ Name: "OTEL_EXPORTER_OTLP_HEADERS" }),
            ]),
          ),
        }),
      ]),
    });
  });
});
