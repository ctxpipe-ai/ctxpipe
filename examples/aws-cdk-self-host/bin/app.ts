#!/usr/bin/env node
import * as cdk from "aws-cdk-lib";
import { CtxpipeSelfHostStack } from "../lib/ctxpipe-self-host-stack";

const app = new cdk.App();

function requireCtx(key: string): string {
  const v = app.node.tryGetContext(key);
  if (v === undefined || v === null || String(v).trim() === "") {
    throw new Error(
      `Missing required CDK context "${key}". Pass -c ${key}=... (see examples/aws-cdk-self-host/README.md).`,
    );
  }
  return String(v).trim();
}

function optCtx(key: string): string | undefined {
  const v = app.node.tryGetContext(key);
  if (v === undefined || v === null) {
    return undefined;
  }
  const s = String(v).trim();
  return s === "" ? undefined : s;
}

function buildConnectorSecrets():
  | {
      githubAppId?: string;
      githubPrivateKey?: string;
      githubWebhookSecret?: string;
      githubClientId?: string;
      githubClientSecret?: string;
      atlassianClientId?: string;
      atlassianClientSecret?: string;
    }
  | undefined {
  const out: {
    githubAppId?: string;
    githubPrivateKey?: string;
    githubWebhookSecret?: string;
    githubClientId?: string;
    githubClientSecret?: string;
    atlassianClientId?: string;
    atlassianClientSecret?: string;
  } = {};
  const githubAppId = optCtx("githubAppId");
  const githubPrivateKey = optCtx("githubPrivateKey");
  const githubWebhookSecret = optCtx("githubWebhookSecret");
  const githubClientId = optCtx("githubClientId");
  const githubClientSecret = optCtx("githubClientSecret");
  const atlassianClientId = optCtx("atlassianClientId");
  const atlassianClientSecret = optCtx("atlassianClientSecret");
  if (githubAppId) out.githubAppId = githubAppId;
  if (githubPrivateKey) out.githubPrivateKey = githubPrivateKey;
  if (githubWebhookSecret) out.githubWebhookSecret = githubWebhookSecret;
  if (githubClientId) out.githubClientId = githubClientId;
  if (githubClientSecret) out.githubClientSecret = githubClientSecret;
  if (atlassianClientId) out.atlassianClientId = atlassianClientId;
  if (atlassianClientSecret) out.atlassianClientSecret = atlassianClientSecret;
  return Object.keys(out).length > 0 ? out : undefined;
}

const stackName = optCtx("stackName") ?? "CtxpipeSelfHostE2E";

const domainName = optCtx("domainName");
const hostedZoneId = optCtx("hostedZoneId");

const customDomainKeys = [domainName, hostedZoneId].filter(Boolean).length;
if (customDomainKeys > 0 && customDomainKeys < 2) {
  throw new Error(
    "Custom domain requires both context keys: domainName and hostedZoneId",
  );
}

const customDomain =
  domainName && hostedZoneId ? { domainName, hostedZoneId } : undefined;

const authSecret = requireCtx("authSecret");
if (authSecret.length < 32) {
  throw new Error("authSecret must be at least 32 characters");
}

new CtxpipeSelfHostStack(app, stackName, {
  stackName,
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
  orgSlug: requireCtx("orgSlug"),
  authSecret,
  modelBaseUrl: "https://openrouter.ai/api/v1",
  modelApiKey: requireCtx("modelApiKey"),
  modelDefaultModel: "moonshotai/kimi-k2.6",
  customDomain,
  connectorSecrets: buildConnectorSecrets(),
  imagesDefaultTag: optCtx("imagesDefaultTag"),
});
