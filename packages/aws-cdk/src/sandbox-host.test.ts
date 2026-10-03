import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import * as cdk from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import { describe, expect, it } from "vitest";
import { CHAT_SANDBOX_IMAGE } from "./chat-sandbox-image";
import { CtxPipe } from "./ctxpipe";
import { sandboxHostClientCommand } from "./internal/sandbox-host-construct";
import type { CtxPipeProps } from "./types";

const execFileAsync = promisify(execFile);

function synth(overrides: Partial<CtxPipeProps> = {}): Template {
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
    ...overrides,
  });
  return Template.fromStack(stack);
}

const cache = new Map<string, Template>();
function template(key: string, overrides: Partial<CtxPipeProps> = {}): Template {
  let found = cache.get(key);
  if (!found) {
    found = synth(overrides);
    cache.set(key, found);
  }
  return found;
}

interface ContainerDefinition {
  Name: string;
  EntryPoint?: string[];
  Command?: string[];
  Environment?: Array<{ Name: string; Value: unknown }>;
  Secrets?: Array<{ Name: string }>;
}

function container(t: Template, name: string): ContainerDefinition {
  for (const resource of Object.values(t.findResources("AWS::ECS::TaskDefinition"))) {
    const found = (
      resource.Properties as { ContainerDefinitions: ContainerDefinition[] }
    ).ContainerDefinitions.find((candidate) => candidate.Name === name);
    if (found) return found;
  }
  throw new Error(`${name} container not found`);
}

function environment(t: Template, name: string): Record<string, unknown> {
  return Object.fromEntries(
    (container(t, name).Environment ?? []).map((entry) => [entry.Name, entry.Value]),
  );
}

function secretNames(t: Template, name: string): string[] {
  return (container(t, name).Secrets ?? []).map((secret) => secret.Name);
}

function launchTemplateData(t: Template): {
  InstanceType: string;
  BlockDeviceMappings: Array<{ DeviceName: string; Ebs: { VolumeSize: number; VolumeType: string } }>;
  MetadataOptions: { HttpTokens: string; HttpPutResponseHopLimit: number };
  ImageId: string;
  UserData: { "Fn::Base64": { "Fn::Join": [string, unknown[]] } };
} {
  const templates = Object.values(t.findResources("AWS::EC2::LaunchTemplate"));
  expect(templates).toHaveLength(1);
  return (templates[0].Properties as { LaunchTemplateData: never }).LaunchTemplateData;
}

/** Rendered user data, with each CloudFormation token as a 128-byte stand-in. */
function userData(t: Template): string {
  return launchTemplateData(t)
    .UserData["Fn::Base64"]["Fn::Join"][1].map((part) =>
      typeof part === "string" ? part : "x".repeat(128),
    )
    .join("");
}

function logicalIdOf(t: Template, type: string, match: (id: string) => boolean): string {
  const id = Object.keys(t.findResources(type)).find(match);
  if (!id) throw new Error(`${type} not found`);
  return id;
}

describe("sandbox host", () => {
  it("is always created as one self-healing instance in private subnets", () => {
    const t = template("small");
    t.resourceCountIs("AWS::AutoScaling::AutoScalingGroup", 1);
    t.hasResource("AWS::AutoScaling::AutoScalingGroup", {
      Properties: Match.objectLike({ MinSize: "1", MaxSize: "1", HealthCheckType: "EC2" }),
      CreationPolicy: { ResourceSignal: { Count: 1 } },
      UpdatePolicy: Match.objectLike({
        AutoScalingRollingUpdate: Match.objectLike({
          MinInstancesInService: 0,
          WaitOnResourceSignals: true,
        }),
      }),
    });
    const subnets = t.findResources("AWS::EC2::Subnet", {
      Properties: { MapPublicIpOnLaunch: false },
    });
    const asg = Object.values(t.findResources("AWS::AutoScaling::AutoScalingGroup"))[0];
    for (const subnet of (asg.Properties as { VPCZoneIdentifier: Array<{ Ref: string }> })
      .VPCZoneIdentifier) {
      expect(Object.keys(subnets)).toContain(subnet.Ref);
    }
    const data = launchTemplateData(t);
    expect(data.MetadataOptions).toEqual({ HttpTokens: "required", HttpPutResponseHopLimit: 1 });
    expect(data.ImageId).toBe("resolve:ssm:/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-arm64");
  });

  it.each([
    ["small", "t4g.medium", 30],
    ["medium", "t4g.large", 50],
    ["large", "t4g.xlarge", 100],
  ] as const)("size %s runs on %s with a %d GiB gp3 Docker volume", (size, instanceType, volume) => {
    const data = launchTemplateData(template(size, { size }));
    expect(data.InstanceType).toBe(instanceType);
    expect(data.BlockDeviceMappings).toContainEqual(
      expect.objectContaining({
        DeviceName: "/dev/xvdb",
        Ebs: expect.objectContaining({ VolumeSize: volume, VolumeType: "gp3", Encrypted: true }),
      }),
    );
  });

  it("takes the instance type and Docker volume from optional props, following the architecture", () => {
    const data = launchTemplateData(
      template("override", {
        size: "large",
        sandboxHost: {
          instanceType: ec2.InstanceType.of(ec2.InstanceClass.M7I, ec2.InstanceSize.LARGE),
          dockerVolumeSizeGiB: 200,
        },
      }),
    );
    expect(data.InstanceType).toBe("m7i.large");
    expect(data.ImageId).toBe("resolve:ssm:/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-x86_64");
    expect(data.BlockDeviceMappings).toContainEqual(
      expect.objectContaining({
        DeviceName: "/dev/xvdb",
        Ebs: expect.objectContaining({ VolumeSize: 200 }),
      }),
    );
  });

  it("rejects a Docker volume too small to hold the chat image and sandboxes", () => {
    expect(() => synth({ sandboxHost: { dockerVolumeSizeGiB: 8 } })).toThrow(
      /dockerVolumeSizeGiB/,
    );
  });

  it("opens the Docker API only to backend and worker, and the backend only to sandboxes", () => {
    const t = template("small");
    const hostGroup = logicalIdOf(t, "AWS::EC2::SecurityGroup", (id) =>
      id.includes("SandboxHostHostSecurityGroup"),
    );
    const clientGroup = logicalIdOf(t, "AWS::EC2::SecurityGroup", (id) =>
      id.includes("SandboxHostClientSecurityGroup"),
    );
    const ingress = Object.values(t.findResources("AWS::EC2::SecurityGroupIngress")).map(
      (resource) =>
        resource.Properties as {
          GroupId: { "Fn::GetAtt": [string, string] };
          SourceSecurityGroupId?: { "Fn::GetAtt": [string, string] };
          FromPort: number;
          ToPort: number;
        },
    );
    const into = (group: string) =>
      ingress
        .filter((rule) => rule.GroupId["Fn::GetAtt"][0] === group)
        .map((rule) => ({
          from: rule.SourceSecurityGroupId?.["Fn::GetAtt"][0],
          ports: [rule.FromPort, rule.ToPort],
        }));
    expect(into(hostGroup)).toEqual(
      expect.arrayContaining([
        { from: clientGroup, ports: [2376, 2376] },
        { from: clientGroup, ports: [32768, 60999] },
      ]),
    );
    expect(into(hostGroup)).toHaveLength(2);
    expect(into(clientGroup)).toEqual(
      expect.arrayContaining([
        { from: hostGroup, ports: [3000, 3000] },
        { from: hostGroup, ports: [32768, 60999] },
      ]),
    );

    const services = Object.values(t.findResources("AWS::ECS::Service")).map(
      (resource) =>
        resource.Properties as {
          ServiceRegistries: Array<{ RegistryArn: { "Fn::GetAtt": [string, string] } }>;
          NetworkConfiguration: {
            AwsvpcConfiguration: { SecurityGroups: Array<{ "Fn::GetAtt": [string, string] }> };
          };
        },
    );
    const withClientGroup = services
      .filter((service) =>
        service.NetworkConfiguration.AwsvpcConfiguration.SecurityGroups.some(
          (group) => group["Fn::GetAtt"][0] === clientGroup,
        ),
      )
      .map((service) => service.ServiceRegistries[0].RegistryArn["Fn::GetAtt"][0]);
    expect(withClientGroup).toHaveLength(2);
    expect(withClientGroup.every((id) => /Backend|Worker/.test(id))).toBe(true);
  });

  it("gives backend and worker the Docker host and TLS client material, and nothing else", () => {
    const t = template("small");
    for (const name of ["backend", "worker"]) {
      expect(environment(t, name)).toMatchObject({
        SANDBOX_PROVIDER: "docker",
        SANDBOX_CHAT_IMAGE: CHAT_SANDBOX_IMAGE,
        DOCKER_HOST: "tcp://sandbox-host.ctxpipe.local:2376",
        DOCKER_TLS_VERIFY: "1",
        DOCKER_CERT_PATH: "/tmp/ctxpipe-docker-tls",
      });
      expect(secretNames(t, name)).toEqual(
        expect.arrayContaining([
          "SANDBOX_HOST_TLS_CA",
          "SANDBOX_HOST_TLS_CERT",
          "SANDBOX_HOST_TLS_KEY",
        ]),
      );
    }
    for (const name of ["ui", "codesearch", "migrate"]) {
      expect(Object.keys(environment(t, name)).filter((key) => /^(SANDBOX|DOCKER)_/.test(key))).toEqual([]);
      expect(secretNames(t, name).filter((key) => key.startsWith("SANDBOX_"))).toEqual([]);
    }
    expect(container(t, "backend").Command?.[0]).toContain("SANDBOX_CALLBACK_HOST");
    expect(container(t, "worker").Command?.[0]).not.toContain("SANDBOX_CALLBACK_HOST");
    expect(container(t, "worker").Command?.[0]).toContain("worker-supervisor.ts");
  });

  it("starts backend and worker only after the host has signalled", () => {
    const t = template("small");
    const asg = logicalIdOf(t, "AWS::AutoScaling::AutoScalingGroup", () => true);
    const services = t.findResources("AWS::ECS::Service");
    const dependent = Object.entries(services)
      .filter(([, resource]) => (resource.DependsOn as string[] | undefined)?.includes(asg))
      .map(([id]) => id);
    expect(dependent).toHaveLength(2);
    expect(dependent.every((id) => /Backend|Worker/.test(id))).toBe(true);
  });

  it("alarms on Docker disk and host memory", () => {
    const t = template("small");
    t.hasResourceProperties("AWS::CloudWatch::Alarm", {
      Namespace: "CWAgent",
      MetricName: "disk_used_percent",
      Dimensions: Match.arrayWith([{ Name: "path", Value: "/var/lib/docker" }]),
      Threshold: 80,
      ComparisonOperator: "GreaterThanOrEqualToThreshold",
    });
    t.hasResourceProperties("AWS::CloudWatch::Alarm", {
      Namespace: "CWAgent",
      MetricName: "mem_used_percent",
      Threshold: 85,
      ComparisonOperator: "GreaterThanOrEqualToThreshold",
    });
  });

  it("boots Docker with TLS, one capped sandbox slice, log rotation, and the chat image, within EC2's 16 KB user data", () => {
    const script = userData(template("small"));
    expect(Buffer.byteLength(script)).toBeLessThan(15 * 1024);
    expect(script).toContain('"tlsverify": true');
    expect(script).toContain('"cgroup-parent": "ctxpipe-sandboxes.slice"');
    expect(script).toContain("MemoryMax=85%");
    expect(script).toContain('"max-size": "10m"');
    expect(script).toContain("-H tcp://0.0.0.0:2376");
    expect(script).toContain('"icc": false');
    expect(script).toContain("iptables -I INPUT -i docker0 -j REJECT");
    expect(script).toContain(`CHAT_IMAGE='${CHAT_SANDBOX_IMAGE}'`);
    expect(script).toContain("subjectAltName=DNS:%s");
    expect(script).toContain("register-instance");
    expect(script.indexOf("register-instance")).toBeLessThan(script.indexOf("signal SUCCESS"));
  });
});

describe("sandbox host client command", () => {
  /** Runs the container command with `env` as the app and returns the app's environment. */
  async function run(
    options: { readonly callbackHost: boolean },
    env: Record<string, string>,
  ): Promise<Record<string, string>> {
    const command = sandboxHostClientCommand("env", options);
    const { stdout } = await execFileAsync(
      command.entryPoint[0],
      [...command.entryPoint.slice(1), ...command.command],
      { env: { PATH: process.env.PATH ?? "", ...env }, encoding: "utf8" },
    );
    return Object.fromEntries(
      stdout
        .trim()
        .split("\n")
        .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]),
    );
  }

  it("writes the client certificates for dockerode and hides them from the app", async () => {
    const certPath = mkdtempSync(join(tmpdir(), "ctxpipe-tls-"));
    try {
      const env = await run(
        { callbackHost: false },
        {
          DOCKER_CERT_PATH: certPath,
          SANDBOX_HOST_TLS_CA: "-----BEGIN CERTIFICATE-----\nca\n-----END CERTIFICATE-----",
          SANDBOX_HOST_TLS_CERT: "cert-pem",
          SANDBOX_HOST_TLS_KEY: "key-pem",
        },
      );
      expect(readFileSync(join(certPath, "ca.pem"), "utf8")).toBe(
        "-----BEGIN CERTIFICATE-----\nca\n-----END CERTIFICATE-----\n",
      );
      expect(readFileSync(join(certPath, "cert.pem"), "utf8")).toBe("cert-pem\n");
      expect(readFileSync(join(certPath, "key.pem"), "utf8")).toBe("key-pem\n");
      expect(Object.keys(env).filter((key) => key.startsWith("SANDBOX_HOST_TLS_"))).toEqual([]);
      expect(env.SANDBOX_CALLBACK_HOST).toBeUndefined();
    } finally {
      rmSync(certPath, { recursive: true, force: true });
    }
  });

  it("sets the backend's callback host to the task's own IP from ECS metadata", async () => {
    const metadata = createServer((_request, response) => {
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify({ Networks: [{ NetworkMode: "awsvpc", IPv4Addresses: ["10.0.3.17"] }] }),
      );
    });
    await new Promise<void>((resolve) => metadata.listen(0, "127.0.0.1", resolve));
    const certPath = mkdtempSync(join(tmpdir(), "ctxpipe-tls-"));
    try {
      const { port } = metadata.address() as AddressInfo;
      const env = await run(
        { callbackHost: true },
        {
          DOCKER_CERT_PATH: certPath,
          SANDBOX_HOST_TLS_CA: "ca",
          SANDBOX_HOST_TLS_CERT: "cert",
          SANDBOX_HOST_TLS_KEY: "key",
          ECS_CONTAINER_METADATA_URI_V4: `http://127.0.0.1:${port}/v4/container`,
        },
      );
      expect(env.SANDBOX_CALLBACK_HOST).toBe("10.0.3.17");
    } finally {
      metadata.close();
      rmSync(certPath, { recursive: true, force: true });
    }
  });
});
