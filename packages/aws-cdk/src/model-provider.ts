import * as cdk from "aws-cdk-lib";
import * as ecs from "aws-cdk-lib/aws-ecs";
import * as iam from "aws-cdk-lib/aws-iam";
import type * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";
import type { CtxPipeModelProviderProps } from "./types";

const DEFAULT_BEDROCK_EMBEDDING_MODEL = "cohere.embed-v4:0";

type ModelProviderKind = "openai-like" | "bedrock";

interface ModelProviderSecretBinding {
  readonly secret: secretsmanager.ISecret;
  readonly field: string;
}

export interface ResolvedModelProviderConfig {
  readonly kind: ModelProviderKind;
  /** Value for MODEL_PROVIDER */
  readonly provider: ModelProviderKind;
  /** OpenAI-compatible base URL; omitted for native Bedrock SDK auth. */
  readonly baseUrl?: string;
  readonly region?: string;
  readonly fastModel: string;
  readonly mediumModel: string;
  readonly highModel: string;
  readonly embeddingModel?: string;
  readonly consumerApiKey?: cdk.SecretValue;
  readonly consumerApiKeyBinding?: ModelProviderSecretBinding;
  readonly taskRolePolicy?: iam.PolicyStatement;
}

interface ModelContainerConfig {
  readonly environment: Record<string, string>;
  readonly secrets: Record<string, ecs.Secret>;
}

function isBedrockProvider(
  props: CtxPipeModelProviderProps,
): props is Extract<CtxPipeModelProviderProps, { kind: "bedrock" }> {
  return props.kind === "bedrock";
}

function resolveTierModels(models: {
  fast: string;
  medium?: string;
  high?: string;
}): { fast: string; medium: string; high: string } {
  const fast = models.fast.trim();
  const medium = models.medium?.trim() || fast;
  const high = models.high?.trim() || medium;
  return { fast, medium, high };
}

function bedrockTaskRolePolicy(): iam.PolicyStatement {
  return new iam.PolicyStatement({
    actions: [
      "bedrock:InvokeModel",
      "bedrock:InvokeModelWithResponseStream",
    ],
    resources: ["*"],
  });
}

export function validateModelProvider(props: CtxPipeModelProviderProps): void {
  if (isBedrockProvider(props)) {
    const fast = props.models.fast?.trim();
    if (!fast) {
      throw new Error(
        "Bedrock modelProvider requires models.fast (non-empty model ID)",
      );
    }
    return;
  }

  if (!props.baseUrl?.trim()) {
    throw new Error("OpenAI-like modelProvider requires baseUrl");
  }

  const fast = props.models.fast?.trim();
  if (!fast) {
    throw new Error(
      "OpenAI-like modelProvider requires models.fast (non-empty model ID)",
    );
  }
}

export function resolveModelProvider(
  props: CtxPipeModelProviderProps,
  stackRegion: string,
): ResolvedModelProviderConfig {
  validateModelProvider(props);

  if (isBedrockProvider(props)) {
    const region = props.region?.trim() || stackRegion;
    const tiers = resolveTierModels(props.models);
    const embeddingModel =
      props.models.embedding?.trim() ?? DEFAULT_BEDROCK_EMBEDDING_MODEL;

    return {
      kind: "bedrock",
      provider: "bedrock",
      region,
      fastModel: tiers.fast,
      mediumModel: tiers.medium,
      highModel: tiers.high,
      embeddingModel,
      taskRolePolicy: bedrockTaskRolePolicy(),
    };
  }

  const tiers = resolveTierModels(props.models);
  const embeddingModel = props.models.embedding?.trim() || undefined;

  return {
    kind: "openai-like",
    provider: "openai-like",
    baseUrl: props.baseUrl.trim(),
    fastModel: tiers.fast,
    mediumModel: tiers.medium,
    highModel: tiers.high,
    embeddingModel,
    consumerApiKey: props.apiKey,
  };
}

export function buildModelContainerConfig(
  resolved: ResolvedModelProviderConfig,
): ModelContainerConfig {
  const environment: Record<string, string> = {
    MODEL_PROVIDER: resolved.provider,
    MODEL_FAST_NAME: resolved.fastModel,
    MODEL_MEDIUM_NAME: resolved.mediumModel,
    MODEL_HIGH_NAME: resolved.highModel,
  };

  if (resolved.baseUrl) {
    environment.MODEL_PROVIDER_URL = resolved.baseUrl;
  }

  if (resolved.region) {
    environment.MODEL_BEDROCK_AWS_REGION = resolved.region;
  }

  if (resolved.embeddingModel) {
    environment.MODEL_EMBEDDING_NAME = resolved.embeddingModel;
  }

  const secrets: Record<string, ecs.Secret> = {};

  if (resolved.kind === "openai-like" && resolved.consumerApiKeyBinding) {
    secrets.MODEL_PROVIDER_API_KEY = ecs.Secret.fromSecretsManager(
      resolved.consumerApiKeyBinding.secret,
      resolved.consumerApiKeyBinding.field,
    );
  }

  return { environment, secrets };
}
