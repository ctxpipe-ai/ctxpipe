import * as cdk from "aws-cdk-lib"
import { Template } from "aws-cdk-lib/assertions"
import { describe, expect, it } from "vitest"

import { CtxPipe } from "./ctxpipe"
import type { CtxPipeSize } from "./types"

const templates = new Map<CtxPipeSize, Template>()
function template(size: CtxPipeSize = "small"): Template {
  let found = templates.get(size)
  if (!found) {
    const app = new cdk.App()
    const stack = new cdk.Stack(app, "TestStack", {
      env: { account: "123456789012", region: "us-east-1" },
    })
    new CtxPipe(stack, "CtxPipe", {
      orgSlug: "acme",
      size,
      customDomain: {
        domainName: "app.example.com",
        hostedZoneId: "Z0123456789ABCDEF",
      },
      modelProvider: { kind: "bedrock", models: { fast: "openai.gpt-5.5" } },
    })
    found = Template.fromStack(stack)
    templates.set(size, found)
  }
  return found
}

type Resource = {
  Properties: Record<string, unknown>
  DependsOn?: string[]
  DeletionPolicy?: string
  UpdateReplacePolicy?: string
}

/** The one resource of `type` whose logical id starts with `prefix`. */
function one(t: Template, type: string, prefix: string): [string, Resource] {
  const found = Object.entries(t.findResources(type)).filter(([id]) =>
    id.startsWith(prefix),
  )
  expect(found).toHaveLength(1)
  return found[0] as [string, Resource]
}

const node = (t: Template, type: string) =>
  one(t, type, "CtxPipeKnowledgeStore")

function userData(t: Template): string {
  const data = node(t, "AWS::EC2::LaunchTemplate")[1].Properties
    .LaunchTemplateData as {
    UserData: { "Fn::Base64": { "Fn::Join": [string, unknown[]] } }
  }
  return data.UserData["Fn::Base64"]["Fn::Join"][1]
    .map((part) => (typeof part === "string" ? part : "<token>"))
    .join("")
}

interface Container {
  Name: string
  Secrets?: Array<{ Name: string; ValueFrom: unknown }>
}
function container(t: Template, name: string): Container {
  for (const resource of Object.values(
    t.findResources("AWS::ECS::TaskDefinition"),
  )) {
    const found = (
      resource.Properties as { ContainerDefinitions: Container[] }
    ).ContainerDefinitions.find((candidate) => candidate.Name === name)
    if (found) return found
  }
  throw new Error(`${name} container not found`)
}

/** The logical id of the secret behind each `CLICKHOUSE_*` secret of `name`. */
function clickhouseSecrets(t: Template, name: string): Record<string, string> {
  return Object.fromEntries(
    (container(t, name).Secrets ?? [])
      .filter((secret) => secret.Name.startsWith("CLICKHOUSE_"))
      .map((secret) => {
        const ref = JSON.stringify(secret.ValueFrom).match(
          /"(CtxPipe[A-Za-z0-9]+)"/,
        )
        return [secret.Name, ref?.[1] ?? ""]
      }),
  )
}

const securityGroupIds = (value: unknown) =>
  JSON.stringify(value).match(/CtxPipe[A-Za-z0-9]+SecurityGroup[A-Z0-9]+/g) ??
  []

describe("knowledge store", () => {
  it("runs ClickHouse on one Graviton host in one private subnet, with IMDSv2", () => {
    const t = template()
    const [, group] = node(t, "AWS::AutoScaling::AutoScalingGroup")
    expect(group).toMatchObject({
      Properties: { MinSize: "1", MaxSize: "1" },
      CreationPolicy: { ResourceSignal: { Count: 1 } },
      UpdatePolicy: {
        AutoScalingRollingUpdate: { MinInstancesInService: 0 },
      },
    })
    const zones = group.Properties.VPCZoneIdentifier as Array<{ Ref: string }>
    expect(zones).toHaveLength(1)
    const privateSubnets = t.findResources("AWS::EC2::Subnet", {
      Properties: { MapPublicIpOnLaunch: false },
    })
    expect(Object.keys(privateSubnets)).toContain(zones[0]?.Ref)
    expect(
      node(t, "AWS::EC2::LaunchTemplate")[1].Properties.LaunchTemplateData,
    ).toMatchObject({
      MetadataOptions: { HttpTokens: "required", HttpPutResponseHopLimit: 1 },
      ImageId:
        "resolve:ssm:/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-arm64",
    })
  })

  it("keeps the data on an encrypted volume in the host's zone that a delete snapshots", () => {
    const t = template()
    const [volumeId, volume] = node(t, "AWS::EC2::Volume")
    expect(volume).toMatchObject({
      Properties: { Encrypted: true, VolumeType: "gp3" },
      DeletionPolicy: "Snapshot",
      UpdateReplacePolicy: "Snapshot",
    })
    const subnetId = (
      node(t, "AWS::AutoScaling::AutoScalingGroup")[1].Properties
        .VPCZoneIdentifier as Array<{ Ref: string }>
    )[0]?.Ref
    expect(volume.Properties.AvailabilityZone).toEqual(
      (
        t.toJSON().Resources[subnetId ?? ""].Properties as Record<
          string,
          unknown
        >
      ).AvailabilityZone,
    )
    // The host attaches it at boot, not the launch template: it outlives the host.
    expect(userData(t)).toContain("aws ec2 attach-volume")
    expect(JSON.stringify(t.toJSON().Resources)).toContain(volumeId)
  })

  it.each([
    ["small", "t4g.large", 50, 10],
    ["medium", "r7g.large", 100, 20],
    ["large", "r7g.xlarge", 200, 40],
  ] as const)(
    "size %s runs on %s with a %d GiB volume and a %d GiB cold cache",
    (size, instanceType, volumeGiB, cacheGiB) => {
      const t = template(size)
      expect(
        node(t, "AWS::EC2::LaunchTemplate")[1].Properties.LaunchTemplateData,
      ).toMatchObject({ InstanceType: instanceType })
      expect(node(t, "AWS::EC2::Volume")[1].Properties.Size).toBe(volumeGiB)
      expect(userData(t)).toContain(`<max_size>${cacheGiB}Gi</max_size>`)
    },
  )

  it("admits only backend, worker and migrate, on 8123", () => {
    const t = template()
    const [hostGroupId, hostGroup] = one(
      t,
      "AWS::EC2::SecurityGroup",
      "CtxPipeKnowledgeStoreHostSecurityGroup",
    )
    const [clientGroupId] = one(
      t,
      "AWS::EC2::SecurityGroup",
      "CtxPipeKnowledgeStoreClientSecurityGroup",
    )
    expect(hostGroup.Properties.SecurityGroupIngress).toBeUndefined()
    const ingress = Object.values(
      t.findResources("AWS::EC2::SecurityGroupIngress"),
    )
      .map((rule) => rule.Properties as Record<string, unknown>)
      .filter((rule) => JSON.stringify(rule.GroupId).includes(hostGroupId))
    expect(ingress).toEqual([
      expect.objectContaining({
        IpProtocol: "tcp",
        FromPort: 8123,
        ToPort: 8123,
        SourceSecurityGroupId: { "Fn::GetAtt": [clientGroupId, "GroupId"] },
      }),
    ])

    const services = Object.entries(t.findResources("AWS::ECS::Service"))
    const clients = services
      .filter(([, service]) =>
        securityGroupIds(service.Properties).includes(clientGroupId),
      )
      .map(([id]) => id)
    expect(clients).toHaveLength(2)
    expect(clients.every((id) => /Backend|Worker/.test(id))).toBe(true)
    const [, migrate] = one(
      t,
      "AWS::CloudFormation::CustomResource",
      "CtxPipeMigrateOnDeployRunMigrations",
    )
    expect(securityGroupIds(migrate.Properties.SecurityGroupIds)).toContain(
      clientGroupId,
    )
  })

  it("gives migrate the admin URL and the two passwords, the backend the reader URL, the worker the writer URL", () => {
    const t = template()
    const prefix = "CtxPipeKnowledgeStore"
    const [readerCredentials] = one(
      t,
      "AWS::SecretsManager::Secret",
      `${prefix}ReaderCredentialsSecret`,
    )
    const [writerCredentials] = one(
      t,
      "AWS::SecretsManager::Secret",
      `${prefix}WriterCredentialsSecret`,
    )
    const urlSecret = (user: string) =>
      one(
        t,
        "AWS::SecretsManager::Secret",
        `CtxPipeSecretsClickhouse${user}Url`,
      )[0]

    expect(clickhouseSecrets(t, "migrate")).toEqual({
      CLICKHOUSE_URL: urlSecret("Admin"),
      CLICKHOUSE_READER_PASSWORD: readerCredentials,
      CLICKHOUSE_WRITER_PASSWORD: writerCredentials,
    })
    expect(clickhouseSecrets(t, "backend")).toEqual({
      CLICKHOUSE_URL: urlSecret("Reader"),
    })
    expect(clickhouseSecrets(t, "worker")).toEqual({
      CLICKHOUSE_URL: urlSecret("Writer"),
    })
    for (const name of ["ui", "codesearch"])
      expect(clickhouseSecrets(t, name)).toEqual({})
  })

  it("generates a URL-safe password for each ClickHouse user", () => {
    const t = template()
    const [, discovery] = node(t, "AWS::ServiceDiscovery::Service")
    expect(discovery.Properties.Name).toBe("clickhouse")
    for (const [user, username] of [
      ["Admin", "ctxpipe"],
      ["Reader", "ctxpipe_reader"],
      ["Writer", "ctxpipe_writer"],
    ]) {
      const [, secret] = one(
        t,
        "AWS::SecretsManager::Secret",
        `CtxPipeKnowledgeStore${user}CredentialsSecret`,
      )
      expect(secret.Properties.GenerateSecretString).toEqual({
        SecretStringTemplate: JSON.stringify({ username }),
        GenerateStringKey: "password",
        ExcludePunctuation: true,
        PasswordLength: 40,
      })
      const [, writer] = one(
        t,
        "AWS::CloudFormation::CustomResource",
        `CtxPipeSecretsClickhouse${user}UrlWriter`,
      )
      expect(writer.Properties).toMatchObject({
        Scheme: "http",
        UrlKey: "CLICKHOUSE_URL",
        Username: username,
        DbHost: "clickhouse.ctxpipe.local",
        DbPort: "8123",
        DatabaseName: "ctxpipe",
      })
    }
  })

  it.each([
    ["CtxPipeKnowledgeStoreInstanceRole", "clickhouse.ctxpipe.local"],
    ["CtxPipeSandboxHostInstanceRole", "sandbox-host.ctxpipe.local"],
  ])(
    "lets %s change only its own record %s in the shared zone",
    (role, hostname) => {
      const dnsWrites = Object.entries(
        template().findResources("AWS::IAM::Policy"),
      )
        .filter(([id]) => id.startsWith(role))
        .flatMap(
          ([, policy]) =>
            (
              policy.Properties as {
                PolicyDocument: { Statement: Array<Record<string, unknown>> }
              }
            ).PolicyDocument.Statement,
        )
        .filter((statement) =>
          JSON.stringify(statement.Action).includes(
            "route53:ChangeResourceRecordSets",
          ),
        )
      expect(dnsWrites).toEqual([
        expect.objectContaining({
          Action: "route53:ChangeResourceRecordSets",
          Condition: {
            "ForAllValues:StringEquals": {
              "route53:ChangeResourceRecordSetsNormalizedRecordNames": [
                hostname,
              ],
            },
          },
        }),
      ])
    },
  )

  it("runs migrate after ClickHouse answers and its URLs exist", () => {
    const t = template()
    const [, migrate] = one(
      t,
      "AWS::CloudFormation::CustomResource",
      "CtxPipeMigrateOnDeployRunMigrations",
    )
    const [groupId] = node(t, "AWS::AutoScaling::AutoScalingGroup")
    expect(migrate.DependsOn).toContain(groupId)
    for (const user of ["Admin", "Reader", "Writer"])
      expect(migrate.DependsOn).toContain(
        one(
          t,
          "AWS::CloudFormation::CustomResource",
          `CtxPipeSecretsClickhouse${user}UrlWriter`,
        )[0],
      )
  })

  it("keeps cold parts on a private, retained bucket that the host reaches only under its prefix", () => {
    const t = template()
    const [bucketId, bucket] = node(t, "AWS::S3::Bucket")
    expect(bucket).toMatchObject({
      Properties: {
        PublicAccessBlockConfiguration: {
          BlockPublicAcls: true,
          BlockPublicPolicy: true,
          IgnorePublicAcls: true,
          RestrictPublicBuckets: true,
        },
        BucketEncryption: expect.anything(),
      },
      DeletionPolicy: "Retain",
    })
    const statements = Object.entries(t.findResources("AWS::IAM::Policy"))
      .filter(([id]) => id.startsWith("CtxPipeKnowledgeStoreInstanceRole"))
      .flatMap(
        ([, policy]) =>
          (
            policy.Properties as {
              PolicyDocument: { Statement: Array<Record<string, unknown>> }
            }
          ).PolicyDocument.Statement,
      )
      .filter((statement) => JSON.stringify(statement).includes(bucketId))
    expect(statements).toHaveLength(2)
    for (const statement of statements) {
      const scope = JSON.stringify(statement)
      expect(
        scope.includes("/clickhouse/*") || scope.includes('"clickhouse/*"'),
      ).toBe(true)
    }
  })

  it("sends S3 traffic of the private subnets through a gateway endpoint, not NAT", () => {
    const t = template()
    const endpoints = Object.values(t.findResources("AWS::EC2::VPCEndpoint"))
    expect(endpoints).toHaveLength(1)
    const endpoint = endpoints[0]?.Properties as Record<string, unknown>
    expect(endpoint.VpcEndpointType).toBe("Gateway")
    expect(JSON.stringify(endpoint.ServiceName)).toContain(".s3")
    const routeTables = JSON.stringify(endpoint.RouteTableIds)
    const privateTables = Object.entries(
      t.findResources("AWS::EC2::SubnetRouteTableAssociation"),
    )
      .filter(([id]) => id.includes("privateSubnet"))
      .map(
        ([, association]) =>
          JSON.stringify(
            (association.Properties as { RouteTableId: unknown }).RouteTableId,
          ).match(/"(CtxPipe[A-Za-z0-9]+)"/)?.[1] ?? "",
      )
    expect(privateTables.length).toBeGreaterThan(0)
    for (const table of privateTables) expect(routeTables).toContain(table)
  })

  it("alarms when the host fails its EC2 status checks", () => {
    const t = template()
    const [groupId] = node(t, "AWS::AutoScaling::AutoScalingGroup")
    expect(node(t, "AWS::CloudWatch::Alarm")[1].Properties).toMatchObject({
      Namespace: "AWS/EC2",
      MetricName: "StatusCheckFailed",
      Dimensions: [{ Name: "AutoScalingGroupName", Value: { Ref: groupId } }],
      Threshold: 1,
      ComparisonOperator: "GreaterThanOrEqualToThreshold",
    })
  })

  it("boots ClickHouse with the hot and cold storage policy, the cold volume on the bucket behind a cache", () => {
    const script = userData(template())
    expect(script).toContain(
      "clickhouse/clickhouse-server:26.10.6.18@sha256:9c55d8d8a77e03e1fd399d59e4d0a1c7a5e42df70098ff1c5d8bd18eb1a5d106",
    )
    expect(script).toContain("--network host")
    // The policy of clickhouse-storage.xml: volumes hot and cold.
    expect(script).toMatch(
      /<hot>\s*<disk>default<\/disk>\s*<\/hot>\s*<cold>\s*<disk>cold<\/disk>\s*<perform_ttl_move_on_insert>0/,
    )
    expect(script).toMatch(
      /<cold>\s*<type>cache<\/type>\s*<disk>cold_s3<\/disk>\s*(<!--[^>]*-->\s*)?<path>cold<\/path>/,
    )
    expect(script).toContain("<boundary_alignment>131072</boundary_alignment>")
    expect(script).toMatch(
      /<endpoint>https:\/\/<token>\/clickhouse\/<\/endpoint>/,
    )
    expect(script).toContain(
      "<use_environment_credentials>true</use_environment_credentials>",
    )
    // The admin password comes from Secrets Manager, never the command line.
    expect(script).toContain("-e CLICKHOUSE_PASSWORD ")
    expect(script).toContain("CLICKHOUSE_DEFAULT_ACCESS_MANAGEMENT=1")
    // The name exists only once ClickHouse answers.
    expect(script.indexOf("8123/ping")).toBeGreaterThan(0)
    expect(script.indexOf("register-instance")).toBeGreaterThan(
      script.indexOf("8123/ping"),
    )
  })
})
