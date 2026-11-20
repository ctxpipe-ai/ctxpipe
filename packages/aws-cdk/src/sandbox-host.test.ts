import * as cdk from "aws-cdk-lib"
import { Match, Template } from "aws-cdk-lib/assertions"
import * as ec2 from "aws-cdk-lib/aws-ec2"
import { describe, expect, it } from "vitest"

import { CtxPipe } from "./ctxpipe"
import { AGENT_VAULT_RATE_LIMIT_ENV } from "./internal/agent-vault-limits"
import type { CtxPipeProps } from "./types"

function synth(overrides: Partial<CtxPipeProps> = {}): Template {
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
    ...overrides,
  })
  return Template.fromStack(stack)
}

const cache = new Map<string, Template>()
function template(
  key: string,
  overrides: Partial<CtxPipeProps> = {},
): Template {
  let found = cache.get(key)
  if (!found) {
    found = synth(overrides)
    cache.set(key, found)
  }
  return found
}

interface ContainerDefinition {
  Name: string
  Image: unknown
  Essential?: boolean
  EntryPoint?: string[]
  Command?: string[]
  Environment?: Array<{ Name: string; Value: unknown }>
  Secrets?: Array<{ Name: string }>
  MountPoints?: Array<{
    SourceVolume: string
    ContainerPath: string
    ReadOnly: boolean
  }>
  DependsOn?: Array<{ ContainerName: string; Condition: string }>
}

/** The containers of the task that runs `name`. */
function taskContainers(t: Template, name: string): ContainerDefinition[] {
  for (const resource of Object.values(
    t.findResources("AWS::ECS::TaskDefinition"),
  )) {
    const containers = (
      resource.Properties as { ContainerDefinitions: ContainerDefinition[] }
    ).ContainerDefinitions
    if (containers.some((candidate) => candidate.Name === name))
      return containers
  }
  throw new Error(`${name} container not found`)
}

function container(t: Template, name: string): ContainerDefinition {
  const found = taskContainers(t, name).find(
    (candidate) => candidate.Name === name,
  )
  if (!found) throw new Error(`${name} container not found`)
  return found
}

function environment(t: Template, name: string): Record<string, unknown> {
  return Object.fromEntries(
    (container(t, name).Environment ?? []).map((entry) => [
      entry.Name,
      entry.Value,
    ]),
  )
}

/** The sandbox host's resources of `type`: the knowledge store has an Auto Scaling group too. */
function sandboxHostResources(
  t: Template,
  type: string,
): Record<string, { Properties: unknown }> {
  return Object.fromEntries(
    Object.entries(t.findResources(type)).filter(([id]) =>
      id.startsWith("CtxPipeSandboxHost"),
    ),
  )
}

function launchTemplateData(t: Template): {
  InstanceType: string
  BlockDeviceMappings: Array<{
    DeviceName: string
    Ebs: { VolumeSize: number; VolumeType: string }
  }>
  MetadataOptions: { HttpTokens: string; HttpPutResponseHopLimit: number }
  ImageId: string
  UserData: { "Fn::Base64": { "Fn::Join": [string, unknown[]] } }
} {
  const templates = Object.values(
    sandboxHostResources(t, "AWS::EC2::LaunchTemplate"),
  )
  expect(templates).toHaveLength(1)
  return (templates[0].Properties as { LaunchTemplateData: never })
    .LaunchTemplateData
}

function userData(t: Template): string {
  return launchTemplateData(t)
    .UserData["Fn::Base64"]["Fn::Join"][1].map((part) =>
      typeof part === "string" ? part : "<token>",
    )
    .join("")
}

function logicalIdOf(
  t: Template,
  type: string,
  match: (id: string) => boolean,
): string {
  const id = Object.keys(t.findResources(type)).find(match)
  if (!id) throw new Error(`${type} not found`)
  return id
}

describe("sandbox host", () => {
  it("is always created as one self-healing Graviton instance in private subnets", () => {
    const t = template("small")
    const groups = Object.values(
      sandboxHostResources(t, "AWS::AutoScaling::AutoScalingGroup"),
    )
    expect(groups).toHaveLength(1)
    const asg = groups[0]
    expect(asg).toMatchObject({
      Properties: {
        MinSize: "1",
        MaxSize: "1",
        HealthCheckType: "EC2",
      },
      CreationPolicy: { ResourceSignal: { Count: 1 } },
      UpdatePolicy: {
        AutoScalingRollingUpdate: {
          MinInstancesInService: 0,
          WaitOnResourceSignals: true,
        },
      },
    })
    const subnets = t.findResources("AWS::EC2::Subnet", {
      Properties: { MapPublicIpOnLaunch: false },
    })
    for (const subnet of (
      asg.Properties as { VPCZoneIdentifier: Array<{ Ref: string }> }
    ).VPCZoneIdentifier) {
      expect(Object.keys(subnets)).toContain(subnet.Ref)
    }
    const data = launchTemplateData(t)
    expect(data.MetadataOptions).toEqual({
      HttpTokens: "required",
      HttpPutResponseHopLimit: 1,
    })
    expect(data.ImageId).toBe(
      "resolve:ssm:/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-arm64",
    )
  })

  it.each([
    ["small", "t4g.medium", 30],
    ["medium", "t4g.large", 50],
    ["large", "t4g.xlarge", 100],
  ] as const)(
    "size %s runs on %s with a %d GiB gp3 Docker volume",
    (size, instanceType, volume) => {
      const data = launchTemplateData(template(size, { size }))
      expect(data.InstanceType).toBe(instanceType)
      expect(data.BlockDeviceMappings).toContainEqual(
        expect.objectContaining({
          DeviceName: "/dev/xvdb",
          Ebs: expect.objectContaining({
            VolumeSize: volume,
            VolumeType: "gp3",
            Encrypted: true,
          }),
        }),
      )
    },
  )

  it("takes the instance type and Docker volume from optional props", () => {
    const data = launchTemplateData(
      template("override", {
        size: "large",
        sandboxHost: {
          instanceType: ec2.InstanceType.of(
            ec2.InstanceClass.M7G,
            ec2.InstanceSize.LARGE,
          ),
          dockerVolumeSizeGiB: 200,
        },
      }),
    )
    expect(data.InstanceType).toBe("m7g.large")
    expect(data.BlockDeviceMappings).toContainEqual(
      expect.objectContaining({
        DeviceName: "/dev/xvdb",
        Ebs: expect.objectContaining({ VolumeSize: 200 }),
      }),
    )
  })

  it("creates no host and gives the services no host settings when enabled is false", () => {
    const t = template("disabled", { sandboxHost: { enabled: false } })
    for (const type of [
      "AWS::AutoScaling::AutoScalingGroup",
      "AWS::EC2::LaunchTemplate",
      "AWS::CloudWatch::Alarm",
    ])
      expect(Object.keys(sandboxHostResources(t, type))).toHaveLength(0)
    expect(
      Object.keys(t.findOutputs("SandboxHostAutoScalingGroupName")),
    ).toHaveLength(0)
    for (const name of ["backend", "worker"]) {
      const env = environment(t, name)
      for (const key of [
        "SANDBOX_PROVIDER",
        "DOCKER_HOST",
        "AGENT_VAULT_ADDR",
      ]) {
        expect(env).not.toHaveProperty(key)
      }
      expect(taskContainers(t, name).map((c) => c.Name)).not.toContain(
        "docker-tls",
      )
    }
  })

  it("keeps the host when enabled is true or unset", () => {
    const t = template("enabled", { sandboxHost: { enabled: true } })
    expect(
      Object.keys(
        sandboxHostResources(t, "AWS::AutoScaling::AutoScalingGroup"),
      ),
    ).toHaveLength(1)
    expect(environment(t, "backend")).toHaveProperty(
      "SANDBOX_PROVIDER",
      "docker",
    )
  })

  it("rejects non-Graviton instance types and Docker volumes too small for sandboxes", () => {
    expect(() =>
      synth({
        sandboxHost: {
          instanceType: ec2.InstanceType.of(
            ec2.InstanceClass.M7I,
            ec2.InstanceSize.LARGE,
          ),
        },
      }),
    ).toThrow(/Graviton \(arm64\).*m7i\.large/)
    expect(() => synth({ sandboxHost: { dockerVolumeSizeGiB: 8 } })).toThrow(
      /dockerVolumeSizeGiB/,
    )
  })

  it("adds the operator's private networks to the Agent Vault allowlist, after the backend subnets", () => {
    const script = userData(
      template("allowlist", {
        sandboxHost: {
          agentVaultNetworkAllowlist: ["192.168.40.0/24", "172.31.5.9"],
        },
      }),
    )
    expect(script).toMatch(
      /AGENT_VAULT_NETWORK_ALLOWLIST='10\.0\.\d+\.0\/\d+(,10\.0\.\d+\.0\/\d+)*,192\.168\.40\.0\/24,172\.31\.5\.9'/,
    )
  })

  it.each([
    ["a cloud metadata address", "169.254.169.254"],
    ["a range with the metadata address", "169.254.0.0/16"],
    ["every address", "0.0.0.0/0"],
    ["a loopback address", "127.0.0.1"],
    ["the loopback range", "127.0.0.0/8"],
    ["a range with the loopback range", "126.0.0.0/7"],
    ["the IPv6 loopback address", "::1"],
    ["the IPv4 unspecified address", "0.0.0.0"],
    ["the IPv6 unspecified address", "::"],
    ["every IPv6 address", "::/0"],
    ["the IPv6 metadata address", "fd00:ec2::254"],
    ["a host name", "git.internal"],
    ["a shell quote", "10.0.0.1' && curl x '"],
  ])("rejects %s in the Agent Vault allowlist", (_kind, entry) => {
    expect(() =>
      synth({ sandboxHost: { agentVaultNetworkAllowlist: [entry] } }),
    ).toThrow(/agentVaultNetworkAllowlist/)
  })

  it("leaves the TLS secrets' values to the host: CloudFormation never sets them", () => {
    const t = template("small")
    const secrets = t.findResources("AWS::SecretsManager::Secret", {
      Properties: {
        Description: Match.stringLikeRegexp("sandbox host: Docker .* TLS"),
      },
    })
    expect(Object.keys(secrets)).toHaveLength(2)
    for (const secret of Object.values(secrets)) {
      expect(secret.Properties).not.toHaveProperty("SecretString")
      expect(secret.Properties).toHaveProperty("GenerateSecretString")
    }
  })

  it("opens the Docker API to backend and worker, and only the backend to sandboxes", () => {
    const t = template("small")
    const group = (name: string) =>
      logicalIdOf(t, "AWS::EC2::SecurityGroup", (id) =>
        id.includes(`SandboxHost${name}SecurityGroup`),
      )
    const host = group("Host")
    const backend = group("Backend")
    const worker = group("Worker")
    const ingress = Object.values(
      t.findResources("AWS::EC2::SecurityGroupIngress"),
    ).map(
      (resource) =>
        resource.Properties as {
          GroupId: { "Fn::GetAtt": [string, string] }
          SourceSecurityGroupId?: { "Fn::GetAtt": [string, string] }
          FromPort: number
          ToPort: number
        },
    )
    const into = (target: string) =>
      ingress
        .filter((rule) => rule.GroupId["Fn::GetAtt"][0] === target)
        .map((rule) => ({
          from: rule.SourceSecurityGroupId?.["Fn::GetAtt"][0],
          ports: [rule.FromPort, rule.ToPort],
        }))
    expect(into(host)).toEqual(
      expect.arrayContaining([
        { from: backend, ports: [2376, 2376] },
        { from: worker, ports: [2376, 2376] },
        { from: backend, ports: [32768, 60999] },
        { from: backend, ports: [14321, 14321] },
        { from: worker, ports: [14321, 14321] },
      ]),
    )
    // Agent Vault's proxy port is for sandboxes on the host only.
    expect(into(host)).toHaveLength(5)
    expect(into(backend)).toEqual(
      expect.arrayContaining([
        { from: host, ports: [3000, 3000] },
        { from: host, ports: [32768, 60999] },
      ]),
    )
    expect(into(worker)).toEqual([])

    const groupsOf = (service: string) => {
      const [resource] = Object.values(
        t.findResources("AWS::ECS::Service", {
          Properties: {
            ServiceRegistries: [
              {
                RegistryArn: {
                  "Fn::GetAtt": [Match.stringLikeRegexp(service), "Arn"],
                },
              },
            ],
          },
        }),
      )
      return (
        resource?.Properties as {
          NetworkConfiguration: {
            AwsvpcConfiguration: {
              SecurityGroups: Array<{ "Fn::GetAtt": [string, string] }>
            }
          }
        }
      ).NetworkConfiguration.AwsvpcConfiguration.SecurityGroups.map(
        (g) => g["Fn::GetAtt"][0],
      )
    }
    expect(groupsOf("Backend")).toContain(backend)
    expect(groupsOf("Backend")).not.toContain(worker)
    expect(groupsOf("Worker")).toContain(worker)
    expect(groupsOf("Worker")).not.toContain(backend)
    for (const service of ["Ui", "Codesearch"]) {
      expect(groupsOf(service)).not.toContain(backend)
      expect(groupsOf(service)).not.toContain(worker)
    }
  })

  it("gives backend and worker the Docker host, the published chat image, and certificate files", () => {
    const t = template("small")
    for (const name of ["backend", "worker"]) {
      const env = environment(t, name)
      expect(env).toMatchObject({
        SANDBOX_PROVIDER: "docker",
        SANDBOX_CHAT_IMAGE: expect.stringMatching(
          /^ghcr\.io\/ctxpipe-ai\/chat-sandbox:/,
        ),
        DOCKER_TLS_VERIFY: "1",
        DOCKER_CERT_PATH: "/run/ctxpipe-docker-tls",
      })
      expect(JSON.stringify(env.DOCKER_HOST)).toMatch(/\.ctxpipe\.local:2376/)
      expect(env).not.toHaveProperty("SANDBOX_CALLBACK_HOST")

      // The image's own command runs; certificates arrive as files only.
      const app = container(t, name)
      expect(app.EntryPoint).toBeUndefined()
      expect(app.Command).toBeUndefined()
      expect((app.Secrets ?? []).map((secret) => secret.Name)).not.toEqual(
        expect.arrayContaining([
          expect.stringMatching(/TLS|^CA$|^CERT$|^KEY$/),
        ]),
      )
      expect(app.DependsOn).toEqual([
        { ContainerName: "docker-tls", Condition: "SUCCESS" },
      ])
      expect(app.MountPoints).toContainEqual({
        SourceVolume: "docker-tls",
        ContainerPath: "/run/ctxpipe-docker-tls",
        ReadOnly: true,
      })
      const certs = taskContainers(t, name).find(
        (candidate) => candidate.Name === "docker-tls",
      )
      expect(certs).toMatchObject({ Essential: false, Image: app.Image })
      expect(
        (certs?.Secrets ?? []).map((secret) => secret.Name).sort(),
      ).toEqual(["CA", "CERT", "KEY"])
    }
    // The chat image moves with the release, like the service images.
    expect(environment(t, "backend").SANDBOX_CHAT_IMAGE).toBe(
      String(container(t, "backend").Image).replace(
        "/backend:",
        "/chat-sandbox:",
      ),
    )
    for (const name of ["ui", "codesearch", "migrate"]) {
      expect(
        Object.keys(environment(t, name)).filter((key) =>
          /^(SANDBOX|DOCKER)_/.test(key),
        ),
      ).toEqual([])
      expect(
        taskContainers(t, name).map((candidate) => candidate.Name),
      ).not.toContain("docker-tls")
    }
  })

  it("starts backend and worker only after the host has signalled", () => {
    const t = template("small")
    const asg = logicalIdOf(t, "AWS::AutoScaling::AutoScalingGroup", (id) =>
      id.startsWith("CtxPipeSandboxHost"),
    )
    const services = t.findResources("AWS::ECS::Service")
    const dependent = Object.entries(services)
      .filter(([, resource]) =>
        (resource.DependsOn as string[] | undefined)?.includes(asg),
      )
      .map(([id]) => id)
    expect(dependent).toHaveLength(2)
    expect(dependent.every((id) => /Backend|Worker/.test(id))).toBe(true)
  })

  it("alarms on Docker disk and host memory", () => {
    const t = template("small")
    t.hasResourceProperties("AWS::CloudWatch::Alarm", {
      Namespace: "CWAgent",
      MetricName: "disk_used_percent",
      Dimensions: Match.arrayWith([{ Name: "path", Value: "/var/lib/docker" }]),
      Threshold: 80,
      ComparisonOperator: "GreaterThanOrEqualToThreshold",
    })
    t.hasResourceProperties("AWS::CloudWatch::Alarm", {
      Namespace: "CWAgent",
      MetricName: "mem_used_percent",
      Threshold: 85,
      ComparisonOperator: "GreaterThanOrEqualToThreshold",
    })
  })

  it("boots Docker with TLS, one capped sandbox slice, isolation, and log rotation", () => {
    const script = userData(template("small"))
    expect(script).toContain('"tlsverify": true')
    expect(script).toContain('"cgroup-parent": "ctxpipe-sandboxes.slice"')
    expect(script).toContain("MemoryMax=85%")
    expect(script).toContain('"max-size": "10m"')
    expect(script).toContain("-H tcp://0.0.0.0:2376")
    expect(script).toContain('"icc": false')
    // Docker forwards published ports with DNAT and does not NAT docker0, so
    // Agent Vault sees each sandbox's own address (CTX-1472).
    expect(script).toContain('"userland-proxy": false')
    expect(script).toContain('"ip-masq": false')
    expect(script).toContain("iptables -I INPUT -i docker0 -j REJECT")
    expect(script).toContain("subjectAltName=DNS:%s")
    expect(script).not.toContain("docker build")
    // Private keys are removed on every exit path.
    expect(script.indexOf(`trap 'rm -rf "$WORK"' EXIT`)).toBeGreaterThan(
      script.indexOf('WORK="$(mktemp -d)"'),
    )
    expect(script.indexOf("register-instance")).toBeLessThan(
      script.indexOf("signal SUCCESS"),
    )
  })

  it("checks each firewall rule with the same spec it inserts", () => {
    const script = userData(template("small"))
    const pairs = [
      ...script.matchAll(
        /iptables (-t \w+ )?-C (.+?) 2>\/dev\/null \|\| iptables (-t \w+ )?-I (.+?)'/g,
      ),
    ]
    const rules = script
      .split("\n")
      .filter((l) => l.startsWith("ExecStartPost=") && l.includes("iptables"))
    // The one other rule puts the jump to DOCKER-USER first in FORWARD.
    const pin = rules.filter((l) => l.includes("iptables -S FORWARD 1"))
    expect(pin).toEqual([
      `ExecStartPost=/bin/sh -c 'iptables -S FORWARD 1 | grep -qx -- "-A FORWARD -j DOCKER-USER" || iptables -I FORWARD 1 -j DOCKER-USER'`,
    ])
    expect(pairs.length).toBeGreaterThan(0)
    expect(pairs.length).toBe(rules.length - pin.length)
    for (const [, checkTable, check, insertTable, insert] of pairs) {
      expect(insertTable).toBe(checkTable)
      expect(insert).toBe(check)
    }
  })

  it("runs Agent Vault on the host and lets sandboxes reach only its proxy", () => {
    const t = template("small")
    const script = userData(t)
    expect(script).toContain("infisical/agent-vault:latest")
    // The proxy tier is raised, the pre-auth gate is off, and an instance
    // setting cannot change them (agent-vault-limits.ts).
    expect(script).not.toContain("RATELIMIT_PROFILE")
    for (const [key, value] of Object.entries(AGENT_VAULT_RATE_LIMIT_ENV))
      expect(script).toContain(` -e ${key}=${value} `)
    expect(script).toContain("AGENT_VAULT_TELEMETRY=false")
    // The proxy may dial the private subnets (backend tasks), not the whole
    // VPC.
    expect(script).toMatch(
      /AGENT_VAULT_NETWORK_ALLOWLIST='[^']*10\.0\.\d+\.0\/\d+/,
    )
    expect(script).not.toContain("AGENT_VAULT_NETWORK_ALLOWLIST='10.0.0.0/16'")
    // While Agent Vault starts, the connection is refused or reset (curl
    // exit 7 or 56). The boot check retries both.
    expect(script).toContain(
      "curl -sf --max-time 5 --retry 30 --retry-all-errors --retry-delay 2 http://127.0.0.1:14321/health",
    )
    // The TLS check has the same retry and time limit.
    expect(script).toContain(
      "curl -sf --max-time 5 --retry 30 --retry-delay 2 --retry-all-errors --resolve",
    )
    // Agent Vault never reaches its own management API or the host: not
    // through the host (INPUT) and not back to its own bridge (hairpin).
    // Replies still pass: else the host's own `/health` check of Agent Vault
    // times out and the boot signals FAILURE (CTX-659).
    expect(script).toContain(
      "iptables -I INPUT -i ctxpipe-av -m conntrack ! --ctstate ESTABLISHED,RELATED -j REJECT",
    )
    expect(script).not.toContain("iptables -I INPUT -i ctxpipe-av -j REJECT")
    expect(script).toContain(
      "iptables -I DOCKER-USER -i ctxpipe-av -o ctxpipe-av -j REJECT",
    )
    // The master password comes from the stack's secret, never the template.
    expect(script).toContain(
      'AGENT_VAULT_MASTER_PASSWORD="$(aws secretsmanager get-secret-value',
    )
    // Sandboxes on docker0: only Agent Vault's proxy port, then replies. Each
    // rule goes to the top, so the last one added is checked first. The proxy
    // accept is above the reply return, because Docker's isolation rules
    // drop what DOCKER-USER returns between two bridges.
    const replies = script.indexOf(
      "iptables -I DOCKER-USER -i docker0 -m conntrack --ctstate ESTABLISHED,RELATED -j RETURN",
    )
    const proxy = script.indexOf(
      "iptables -I DOCKER-USER -i docker0 -o ctxpipe-av -p tcp --dport 14322 -j ACCEPT",
    )
    const reject = script.indexOf(
      "iptables -I DOCKER-USER -i docker0 -j REJECT",
    )
    expect(reject).toBeGreaterThan(-1)
    expect(replies).toBeGreaterThan(reject)
    expect(proxy).toBeGreaterThan(replies)
    // The proxy's replies back to docker0, and past Docker 28's raw drop of
    // packets that come from another bridge.
    expect(script).toContain(
      "iptables -I DOCKER-USER -i ctxpipe-av -o docker0 -p tcp --sport 14322 -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT",
    )
    expect(script).toContain(
      "iptables -t raw -I PREROUTING -i ctxpipe-av -p tcp --sport 14322 -j ACCEPT",
    )
    // Without docker-proxy, Agent Vault's connection to a sandbox's published
    // port on the host address is forwarded to docker0: DOCKER-USER refuses it.
    expect(script).toContain(
      "iptables -I DOCKER-USER -i ctxpipe-av -o docker0 -m conntrack ! --ctstate ESTABLISHED,RELATED -j REJECT",
    )
    // The proxy port is the only docker0 accept, and docker0 has no INPUT
    // accept: the proxy is forwarded, not served by docker-proxy on the host.
    const accepts = script
      .split("\n")
      .filter((l) => /-i docker0\b.*-j ACCEPT/.test(l))
    expect(accepts).toHaveLength(1)
    expect(accepts[0]).toContain(
      "DOCKER-USER -i docker0 -o ctxpipe-av -p tcp --dport 14322 -j ACCEPT",
    )
    expect(script).not.toMatch(/INPUT -i docker0 .*-j ACCEPT/)
    expect(script.indexOf("ctxpipe-agent-vault")).toBeLessThan(
      script.indexOf("signal SUCCESS"),
    )
  })

  it("generates the Agent Vault passwords in Secrets Manager and gives the owner password to backend and worker", () => {
    const t = template("small")
    const generated = Object.values(
      t.findResources("AWS::SecretsManager::Secret"),
    ).filter(
      (secret) =>
        (secret.Properties as { Description?: string }).Description?.includes(
          "Agent Vault",
        ) &&
        (secret.Properties as { GenerateSecretString?: unknown })
          .GenerateSecretString,
    )
    expect(generated).toHaveLength(2)
    for (const name of ["backend", "worker"]) {
      const app = container(t, name)
      expect(app.Secrets?.map((secret) => secret.Name)).toContain(
        "AGENT_VAULT_OWNER_PASSWORD",
      )
      expect(
        app.Environment?.find((entry) => entry.Name === "AGENT_VAULT_ADDR"),
      ).toBeDefined()
      // The deploy names the backend's callback host (Agent Vault rules take
      // host names), not AWS_REGION.
      expect(
        app.Environment?.find(
          (entry) => entry.Name === "SANDBOX_CALLBACK_DNS_SUFFIX",
        ),
      ).toBeDefined()
    }
  })
})
