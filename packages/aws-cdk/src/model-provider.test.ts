import * as cdk from "aws-cdk-lib";
import * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";
import { describe, expect, it } from "vitest";
import {
  buildModelContainerConfig,
  resolveModelProvider,
  validateModelProvider,
} from "./model-provider";

const DEFAULT_BEDROCK_EMBEDDING_MODEL = "cohere.embed-v4:0";
import type { CtxPipeModelProviderProps } from "./types";

function openAiLike(
  overrides: Partial<Extract<CtxPipeModelProviderProps, { kind?: "openai-like" }>> = {},
): CtxPipeModelProviderProps {
  return {
    baseUrl: "https://api.openai.com/v1",
    apiKey: cdk.SecretValue.unsafePlainText("sk-test"),
    defaultModel: "gpt-4o-mini",
    ...overrides,
  };
}

function bedrock(
  overrides: Partial<Extract<CtxPipeModelProviderProps, { kind: "bedrock" }>> = {},
): CtxPipeModelProviderProps {
  return {
    kind: "bedrock",
    models: { fast: "anthropic.claude-sonnet-4-20250514-v1:0" },
    ...overrides,
  };
}

describe("resolveModelProvider", () => {
  it("cascades fast → medium → high tiers", () => {
    const resolved = resolveModelProvider(
      openAiLike({
        models: {
          fast: "fast-model",
          medium: "medium-model",
          high: "high-model",
        },
      }),
      "us-east-1",
    );

    expect(resolved.fastModel).toBe("fast-model");
    expect(resolved.mediumModel).toBe("medium-model");
    expect(resolved.highModel).toBe("high-model");
  });

  it("falls back medium to fast and high to medium", () => {
    const onlyFast = resolveModelProvider(
      openAiLike({ defaultModel: "only-fast" }),
      "us-east-1",
    );
    expect(onlyFast.fastModel).toBe("only-fast");
    expect(onlyFast.mediumModel).toBe("only-fast");
    expect(onlyFast.highModel).toBe("only-fast");

    const fastAndMedium = resolveModelProvider(
      openAiLike({
        models: { fast: "f", medium: "m" },
        defaultModel: "ignored-when-fast-set",
      }),
      "us-east-1",
    );
    expect(fastAndMedium.fastModel).toBe("f");
    expect(fastAndMedium.mediumModel).toBe("m");
    expect(fastAndMedium.highModel).toBe("m");
  });

  it("applies Bedrock defaults (region, embedding model, IAM policy)", () => {
    const stackRegion = "eu-west-1";
    const resolved = resolveModelProvider(bedrock(), stackRegion);

    expect(resolved.kind).toBe("bedrock");
    expect(resolved.provider).toBe("bedrock");
    expect(resolved.baseUrl).toBeUndefined();
    expect(resolved.region).toBe(stackRegion);
    expect(resolved.embeddingModel).toBe(DEFAULT_BEDROCK_EMBEDDING_MODEL);
    expect(resolved.taskRolePolicy).toBeDefined();
    expect(resolved.taskRolePolicy?.actions).toEqual(
      expect.arrayContaining([
        "bedrock:InvokeModel",
        "bedrock:InvokeModelWithResponseStream",
      ]),
    );
    expect(resolved.taskRolePolicy?.actions).not.toContain(
      "bedrock:CallWithBearerToken",
    );
  });

  it("uses explicit Bedrock region when provided", () => {
    const resolved = resolveModelProvider(
      bedrock({ region: "ap-southeast-2" }),
      "us-east-1",
    );

    expect(resolved.region).toBe("ap-southeast-2");
    expect(resolved.baseUrl).toBeUndefined();
  });

  it("supports openai-like backward compat with defaultModel only", () => {
    const resolved = resolveModelProvider(
      openAiLike({ defaultModel: "legacy/default" }),
      "us-east-1",
    );

    expect(resolved.kind).toBe("openai-like");
    expect(resolved.fastModel).toBe("legacy/default");
    expect(resolved.mediumModel).toBe("legacy/default");
    expect(resolved.highModel).toBe("legacy/default");
    expect(resolved.embeddingModel).toBeUndefined();
    expect(resolved.consumerApiKey).toBeDefined();
  });
});

describe("validateModelProvider", () => {
  it("rejects openai-like without baseUrl", () => {
    expect(() =>
      validateModelProvider({
        baseUrl: "  ",
        apiKey: cdk.SecretValue.unsafePlainText("k"),
        defaultModel: "m",
      }),
    ).toThrow(/baseUrl/i);
  });

  it("rejects openai-like without defaultModel or models.fast", () => {
    expect(() =>
      validateModelProvider({
        baseUrl: "https://example.com/v1",
        apiKey: cdk.SecretValue.unsafePlainText("k"),
        defaultModel: "  ",
      }),
    ).toThrow(/defaultModel|models\.fast/i);
  });

  it("rejects bedrock without models.fast", () => {
    expect(() =>
      validateModelProvider({
        kind: "bedrock",
        models: {},
      }),
    ).toThrow(/models\.fast/i);
  });
});

describe("buildModelContainerConfig", () => {
  it("builds openai-like env and secrets including MODEL_PROVIDER_API_KEY", () => {
    const app = new cdk.App();
    const stack = new cdk.Stack(app, "TestStack");
    const secret = new secretsmanager.Secret(stack, "ModelSecret", {
      secretObjectValue: {
        API_KEY: cdk.SecretValue.unsafePlainText("sk-test"),
      },
    });

    const resolved = resolveModelProvider(
      openAiLike({
        models: {
          fast: "fast",
          medium: "medium",
          high: "high",
          embedding: "text-embedding-3-large",
        },
      }),
      "us-east-1",
    );

    const { environment, secrets } = buildModelContainerConfig({
      ...resolved,
      consumerApiKeyBinding: { secret, field: "API_KEY" },
    });

    expect(environment).toEqual({
      MODEL_PROVIDER: "openai-like",
      MODEL_PROVIDER_URL: "https://api.openai.com/v1",
      MODEL_FAST_NAME: "fast",
      MODEL_MEDIUM_NAME: "medium",
      MODEL_HIGH_NAME: "high",
      MODEL_EMBEDDING_NAME: "text-embedding-3-large",
    });
    expect(Object.keys(secrets)).toEqual(["MODEL_PROVIDER_API_KEY"]);
  });

  it("omits MODEL_PROVIDER_API_KEY and Mantle URL for bedrock", () => {
    const resolved = resolveModelProvider(bedrock(), "us-west-2");
    const { environment, secrets } = buildModelContainerConfig(resolved);

    expect(environment.MODEL_PROVIDER).toBe("bedrock");
    expect(environment.MODEL_PROVIDER_URL).toBeUndefined();
    expect(environment.MODEL_BEDROCK_AWS_REGION).toBe("us-west-2");
    expect(environment.MODEL_EMBEDDING_NAME).toBe(
      DEFAULT_BEDROCK_EMBEDDING_MODEL,
    );
    expect(secrets).not.toHaveProperty("MODEL_PROVIDER_API_KEY");
    expect(Object.keys(secrets)).toEqual([]);
  });
});
