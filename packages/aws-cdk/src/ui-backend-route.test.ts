import * as cdk from "aws-cdk-lib"
import { Match, Template } from "aws-cdk-lib/assertions"
import { describe, expect, it } from "vitest"

import { CtxPipe } from "./ctxpipe"

function synth(): Template {
  const app = new cdk.App()
  const stack = new cdk.Stack(app, "TestStack", {
    env: { account: "123456789012", region: "us-east-1" },
  })
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
  })
  return Template.fromStack(stack)
}

describe("UI server render route to the backend", () => {
  const template = synth()

  it("calls the backend on its Cloud Map address and allows the public origin", () => {
    template.hasResourceProperties("AWS::ECS::TaskDefinition", {
      ContainerDefinitions: Match.arrayWith([
        Match.objectLike({
          Name: "ui",
          Environment: Match.arrayWith([
            {
              Name: "AUTH_BASE_URL",
              Value: "http://backend.ctxpipe.local:3000",
            },
            { Name: "AUTH_ALLOWED_ORIGINS", Value: "https://app.example.com" },
          ]),
        }),
      ]),
    })
  })

  it("lets the app security group reach the backend on 3000", () => {
    const appGroup = Object.keys(
      template.findResources("AWS::EC2::SecurityGroup"),
    ).find((id) => id.includes("AppSecurityGroup"))
    expect(appGroup).toBeDefined()
    template.hasResourceProperties("AWS::EC2::SecurityGroupIngress", {
      GroupId: { "Fn::GetAtt": [appGroup, "GroupId"] },
      SourceSecurityGroupId: { "Fn::GetAtt": [appGroup, "GroupId"] },
      FromPort: 3000,
      ToPort: 3000,
      IpProtocol: "tcp",
    })
  })
})
