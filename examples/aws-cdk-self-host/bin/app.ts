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
const certificateArn = optCtx("certificateArn");

const customDomainKeys = [domainName, hostedZoneId, certificateArn].filter(
  Boolean,
).length;
if (customDomainKeys > 0 && customDomainKeys < 3) {
  throw new Error(
    "Custom domain requires all three context keys: domainName, hostedZoneId, certificateArn",
  );
}

const customDomain =
  domainName && hostedZoneId && certificateArn
    ? { domainName, hostedZoneId, certificateArn }
    : undefined;

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
  authSecret,
  modelBaseUrl: requireCtx("modelBaseUrl"),
  modelApiKey: requireCtx("modelApiKey"),
  modelDefaultModel: requireCtx("modelDefaultModel"),
  customDomain,
  connectorSecrets: buildConnectorSecrets(),
  imagesDefaultTag: optCtx("imagesDefaultTag"),
});
