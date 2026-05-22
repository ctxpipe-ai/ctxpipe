#!/usr/bin/env node
import * as cdk from "aws-cdk-lib";
import { CtxPipe, type CtxPipeProps, type CtxPipeSize } from "@ctxpipe/aws-cdk";

const app = new cdk.App();

const stackName =
  (app.node.tryGetContext("stackName") as string | undefined) ?? "CtxpipeSelfHostE2E";

const ctx = (key: string): unknown => app.node.tryGetContext(key);
const sizeContext = ctx("size");
const size =
  typeof sizeContext === "string" && sizeContext.length > 0
    ? (sizeContext as CtxPipeSize)
    : undefined;

const ctxPipeProps: CtxPipeProps = {
  orgSlug: String(ctx("orgSlug") ?? ""),
  size,
  modelProvider: {
    baseUrl: String(ctx("modelBaseUrl") ?? ""),
    apiKey: cdk.SecretValue.unsafePlainText(String(ctx("modelApiKey") ?? "")),
    defaultModel: String(ctx("modelDefaultModel") ?? ""),
  },
  customDomain: {
    domainName: String(ctx("domainName") ?? ""),
    hostedZoneId: String(ctx("hostedZoneId") ?? ""),
  },
};

/** `CtxPipe` is a construct; AWS resources must live under a {@link cdk.Stack}. */
const stack = new cdk.Stack(app, stackName, {
  stackName,
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});

new CtxPipe(stack, "CtxPipe", ctxPipeProps);
