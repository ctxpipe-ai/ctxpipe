#!/usr/bin/env npx tsx
/**
 * Destroy the aws-cdk-self-host CloudFormation stack and purge known leftovers
 * that CDK RemovalPolicy leaves behind (EFS RETAIN, Aurora/Neptune SNAPSHOT,
 * Secrets Manager recovery, orphan log groups).
 *
 * Usage:
 *   pnpm --filter @ctxpipe/aws-cdk-self-host teardown
 *   pnpm --filter @ctxpipe/aws-cdk-self-host teardown -- --dry-run
 *   pnpm --filter @ctxpipe/aws-cdk-self-host teardown -- --purge-ses
 *   pnpm --filter @ctxpipe/aws-cdk-self-host teardown -- -c stackName=MyStack
 */
import {
  CloudFormationClient,
  DeleteStackCommand,
  DescribeStacksCommand,
  ListStackResourcesCommand,
  type StackResourceSummary,
} from "@aws-sdk/client-cloudformation";
import {
  CloudWatchLogsClient,
  DeleteLogGroupCommand,
  DescribeLogGroupsCommand,
} from "@aws-sdk/client-cloudwatch-logs";
import {
  DescribeNatGatewaysCommand,
  EC2Client,
} from "@aws-sdk/client-ec2";
import {
  DescribeServicesCommand,
  ECSClient,
  ListClustersCommand,
  ListServicesCommand,
} from "@aws-sdk/client-ecs";
import {
  DeleteFileSystemCommand,
  DeleteMountTargetCommand,
  DescribeFileSystemsCommand,
  DescribeMountTargetsCommand,
  EFSClient,
} from "@aws-sdk/client-efs";
import {
  DescribeLoadBalancersCommand,
  ElasticLoadBalancingV2Client,
} from "@aws-sdk/client-elastic-load-balancing-v2";
import {
  DeleteDBClusterSnapshotCommand,
  DescribeDBClusterSnapshotsCommand,
  DescribeDBClustersCommand,
  RDSClient,
} from "@aws-sdk/client-rds";
import {
  DeleteDBClusterSnapshotCommand as DeleteNeptuneSnapshotCommand,
  DescribeDBClusterSnapshotsCommand as DescribeNeptuneSnapshotsCommand,
  DescribeDBClustersCommand as DescribeNeptuneClustersCommand,
  NeptuneClient,
} from "@aws-sdk/client-neptune";
import {
  DeleteSecretCommand,
  DescribeSecretCommand,
  ListSecretsCommand,
  SecretsManagerClient,
} from "@aws-sdk/client-secrets-manager";
import {
  DeleteEmailIdentityCommand,
  SESv2Client,
} from "@aws-sdk/client-sesv2";
import { readFileSync } from "node:fs";
import { join } from "node:path";

type StackInventory = {
  efsIds: string[];
  rdsClusterIds: string[];
  neptuneClusterIds: string[];
  secretArns: string[];
  logGroupNames: string[];
  lambdaNames: string[];
  vpcId: string | undefined;
};

type CliOptions = {
  dryRun: boolean;
  purgeSes: boolean;
  skipDestroy: boolean;
  stackName: string;
  domainName: string | undefined;
};

const packageRoot = join(__dirname, "..");

function parseArgs(argv: string[]): CliOptions {
  const dryRun = argv.includes("--dry-run");
  const purgeSes = argv.includes("--purge-ses");
  const skipDestroy = argv.includes("--skip-destroy");

  let stackName =
    process.env.CDK_STACK_NAME?.trim() ||
    process.env.STACK_NAME?.trim() ||
    "";
  let domainName = process.env.DOMAIN_NAME?.trim() || "";

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "-c" || arg === "--context") {
      const value = argv[i + 1];
      if (!value) continue;
      i++;
      const eq = value.indexOf("=");
      if (eq <= 0) continue;
      const key = value.slice(0, eq);
      const val = value.slice(eq + 1);
      if (key === "stackName" && val) stackName = val;
      if (key === "domainName" && val) domainName = val;
      continue;
    }
    if (arg.startsWith("-c") && arg.includes("=")) {
      const value = arg.slice(2);
      const eq = value.indexOf("=");
      if (eq <= 0) continue;
      const key = value.slice(0, eq);
      const val = value.slice(eq + 1);
      if (key === "stackName" && val) stackName = val;
      if (key === "domainName" && val) domainName = val;
    }
  }

  if (!stackName || !domainName) {
    try {
      const cdkJson = JSON.parse(
        readFileSync(join(packageRoot, "cdk.json"), "utf8"),
      ) as { context?: Record<string, unknown> };
      if (!stackName && typeof cdkJson.context?.stackName === "string") {
        stackName = cdkJson.context.stackName;
      }
      if (!domainName && typeof cdkJson.context?.domainName === "string") {
        domainName = cdkJson.context.domainName;
      }
    } catch {
      // ignore missing cdk.json
    }
  }

  return {
    dryRun,
    purgeSes,
    skipDestroy,
    stackName: stackName || "CtxpipeSelfHostE2E",
    domainName: domainName || undefined,
  };
}

function log(message: string): void {
  console.log(message);
}

function region(): string {
  return (
    process.env.AWS_REGION?.trim() ||
    process.env.AWS_DEFAULT_REGION?.trim() ||
    process.env.CDK_DEFAULT_REGION?.trim() ||
    "us-east-1"
  );
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function stackExists(
  cfn: CloudFormationClient,
  stackName: string,
): Promise<boolean> {
  try {
    const out = await cfn.send(new DescribeStacksCommand({ StackName: stackName }));
    const status = out.Stacks?.[0]?.StackStatus;
    if (!status) return false;
    return !status.startsWith("DELETE_COMPLETE");
  } catch (error) {
    const name = (error as { name?: string }).name;
    if (name === "ValidationError") return false;
    throw error;
  }
}

async function waitForStackDeleted(
  cfn: CloudFormationClient,
  stackName: string,
): Promise<void> {
  for (;;) {
    const exists = await stackExists(cfn, stackName);
    if (!exists) {
      log(`Stack ${stackName} is gone.`);
      return;
    }
    const out = await cfn.send(new DescribeStacksCommand({ StackName: stackName }));
    const status = out.Stacks?.[0]?.StackStatus ?? "UNKNOWN";
    log(`Waiting for stack delete… ${status}`);
    if (status === "DELETE_FAILED") {
      throw new Error(
        `Stack ${stackName} entered DELETE_FAILED. Fix blockers in the console and re-run teardown.`,
      );
    }
    await sleep(15_000);
  }
}

async function listAllStackResources(
  cfn: CloudFormationClient,
  stackName: string,
): Promise<StackResourceSummary[]> {
  const resources: StackResourceSummary[] = [];
  let nextToken: string | undefined;
  do {
    const page = await cfn.send(
      new ListStackResourcesCommand({
        StackName: stackName,
        NextToken: nextToken,
      }),
    );
    resources.push(...(page.StackResourceSummaries ?? []));
    nextToken = page.NextToken;
  } while (nextToken);
  return resources;
}

function inventoryFromResources(resources: StackResourceSummary[]): StackInventory {
  const efsIds: string[] = [];
  const rdsClusterIds: string[] = [];
  const neptuneClusterIds: string[] = [];
  const secretArns: string[] = [];
  const logGroupNames: string[] = [];
  const lambdaNames: string[] = [];
  let vpcId: string | undefined;

  for (const resource of resources) {
    const type = resource.ResourceType;
    const id = resource.PhysicalResourceId;
    if (!type || !id) continue;

    switch (type) {
      case "AWS::EFS::FileSystem":
        efsIds.push(id);
        break;
      case "AWS::RDS::DBCluster":
        rdsClusterIds.push(id);
        break;
      case "AWS::Neptune::DBCluster":
        neptuneClusterIds.push(id);
        break;
      case "AWS::SecretsManager::Secret":
        secretArns.push(id);
        break;
      case "AWS::Logs::LogGroup":
        logGroupNames.push(id);
        break;
      case "AWS::Lambda::Function":
        lambdaNames.push(id);
        logGroupNames.push(`/aws/lambda/${id}`);
        break;
      case "AWS::EC2::VPC":
        vpcId = id;
        break;
      default:
        break;
    }
  }

  return {
    efsIds: [...new Set(efsIds)],
    rdsClusterIds: [...new Set(rdsClusterIds)],
    neptuneClusterIds: [...new Set(neptuneClusterIds)],
    secretArns: [...new Set(secretArns)],
    logGroupNames: [...new Set(logGroupNames)],
    lambdaNames: [...new Set(lambdaNames)],
    vpcId,
  };
}

async function discoverRetainedEfs(
  efs: EFSClient,
  stackName: string,
  knownIds: string[],
): Promise<string[]> {
  const ids = new Set(knownIds);
  let marker: string | undefined;
  do {
    const page = await efs.send(new DescribeFileSystemsCommand({ Marker: marker }));
    for (const fs of page.FileSystems ?? []) {
      const name = fs.Name ?? "";
      const id = fs.FileSystemId;
      if (!id) continue;
      // CDK Name tag for nested constructs: Stack/CtxPipe/DataPlane/CodesearchEfs
      if (name.startsWith(`${stackName}/`) || name.includes(`/${stackName}/`)) {
        ids.add(id);
      }
    }
    marker = page.NextMarker;
  } while (marker);
  return [...ids];
}

async function discoverSecretsForStack(
  secrets: SecretsManagerClient,
  stackName: string,
  knownArns: string[],
): Promise<string[]> {
  const arns = new Set(knownArns);
  let nextToken: string | undefined;
  do {
    const page = await secrets.send(
      new ListSecretsCommand({
        IncludePlannedDeletion: true,
        NextToken: nextToken,
      }),
    );
    for (const secret of page.SecretList ?? []) {
      const name = secret.Name ?? "";
      const arn = secret.ARN;
      if (!arn) continue;
      const owningStack = secret.Tags?.find(
        (tag) => tag.Key === "aws:cloudformation:stack-name",
      )?.Value;
      if (
        owningStack === stackName ||
        name.includes(stackName) ||
        name.startsWith("CtxPipe")
      ) {
        arns.add(arn);
      }
    }
    nextToken = page.NextToken;
  } while (nextToken);
  return [...arns];
}

/**
 * Prefer CloudFormation DeleteStack over `cdk destroy` so teardown still works
 * when the current app synth fails validation (e.g. model id drift) but the
 * stack already exists in the account.
 */
async function deleteCloudFormationStack(
  cfn: CloudFormationClient,
  stackName: string,
  dryRun: boolean,
): Promise<void> {
  if (dryRun) {
    log(`[dry-run] would DeleteStack ${stackName}`);
    return;
  }
  log(`Deleting CloudFormation stack ${stackName}…`);
  await cfn.send(new DeleteStackCommand({ StackName: stackName }));
}

async function deleteEfsFilesystem(
  efs: EFSClient,
  fileSystemId: string,
  dryRun: boolean,
): Promise<void> {
  if (dryRun) {
    log(`[dry-run] would delete EFS ${fileSystemId}`);
    return;
  }
  log(`Deleting EFS ${fileSystemId}…`);
  const mounts = await efs.send(
    new DescribeMountTargetsCommand({ FileSystemId: fileSystemId }),
  );
  for (const mt of mounts.MountTargets ?? []) {
    if (!mt.MountTargetId) continue;
    log(`  deleting mount target ${mt.MountTargetId}`);
    await efs.send(new DeleteMountTargetCommand({ MountTargetId: mt.MountTargetId }));
  }

  for (let attempt = 0; attempt < 40; attempt++) {
    const remaining = await efs.send(
      new DescribeMountTargetsCommand({ FileSystemId: fileSystemId }),
    );
    if ((remaining.MountTargets ?? []).length === 0) break;
    await sleep(5_000);
  }

  await efs.send(new DeleteFileSystemCommand({ FileSystemId: fileSystemId }));
  log(`  deleted EFS ${fileSystemId}`);
}

async function deleteRdsSnapshotsForClusters(
  rds: RDSClient,
  clusterIds: string[],
  dryRun: boolean,
): Promise<void> {
  if (clusterIds.length === 0) return;
  const snaps = await rds.send(new DescribeDBClusterSnapshotsCommand({}));
  for (const snap of snaps.DBClusterSnapshots ?? []) {
    const id = snap.DBClusterSnapshotIdentifier;
    const source = snap.DBClusterIdentifier;
    if (!id || !source || !clusterIds.includes(source)) continue;
    if (dryRun) {
      log(`[dry-run] would delete RDS cluster snapshot ${id}`);
      continue;
    }
    log(`Deleting RDS cluster snapshot ${id}…`);
    await rds.send(
      new DeleteDBClusterSnapshotCommand({ DBClusterSnapshotIdentifier: id }),
    );
  }
}

async function deleteNeptuneSnapshotsForClusters(
  neptune: NeptuneClient,
  clusterIds: string[],
  dryRun: boolean,
): Promise<void> {
  if (clusterIds.length === 0) return;
  const snaps = await neptune.send(new DescribeNeptuneSnapshotsCommand({}));
  for (const snap of snaps.DBClusterSnapshots ?? []) {
    const id = snap.DBClusterSnapshotIdentifier;
    const source = snap.DBClusterIdentifier;
    if (!id || !source || !clusterIds.includes(source)) continue;
    if (dryRun) {
      log(`[dry-run] would delete Neptune cluster snapshot ${id}`);
      continue;
    }
    log(`Deleting Neptune cluster snapshot ${id}…`);
    await neptune.send(
      new DeleteNeptuneSnapshotCommand({ DBClusterSnapshotIdentifier: id }),
    );
  }
}

async function forceDeleteSecret(
  secrets: SecretsManagerClient,
  secretArn: string,
  dryRun: boolean,
): Promise<void> {
  if (dryRun) {
    log(`[dry-run] would force-delete secret ${secretArn}`);
    return;
  }
  try {
    const described = await secrets.send(
      new DescribeSecretCommand({ SecretId: secretArn }),
    );
    log(`Force-deleting secret ${described.Name ?? secretArn}…`);
    await secrets.send(
      new DeleteSecretCommand({
        SecretId: secretArn,
        ForceDeleteWithoutRecovery: true,
      }),
    );
  } catch (error) {
    const name = (error as { name?: string }).name;
    if (name === "ResourceNotFoundException") {
      log(`  secret already gone: ${secretArn}`);
      return;
    }
    throw error;
  }
}

async function deleteLogGroup(
  logs: CloudWatchLogsClient,
  logGroupName: string,
  dryRun: boolean,
): Promise<void> {
  if (dryRun) {
    log(`[dry-run] would delete log group ${logGroupName}`);
    return;
  }
  try {
    await logs.send(new DeleteLogGroupCommand({ logGroupName }));
    log(`Deleted log group ${logGroupName}`);
  } catch (error) {
    const name = (error as { name?: string }).name;
    if (name === "ResourceNotFoundException") return;
    throw error;
  }
}

async function discoverOrphanLogGroups(
  logs: CloudWatchLogsClient,
  stackName: string,
  known: string[],
): Promise<string[]> {
  const names = new Set(known);
  let nextToken: string | undefined;
  do {
    const page = await logs.send(
      new DescribeLogGroupsCommand({
        logGroupNamePrefix: stackName,
        nextToken,
      }),
    );
    for (const group of page.logGroups ?? []) {
      if (group.logGroupName) names.add(group.logGroupName);
    }
    nextToken = page.nextToken;
  } while (nextToken);
  return [...names];
}

async function purgeSesIdentity(
  ses: SESv2Client,
  domainName: string | undefined,
  dryRun: boolean,
): Promise<void> {
  if (!domainName) {
    log("Skipping SES purge: no domainName configured.");
    return;
  }
  // SES identity is typically the parent zone (e.g. aws.ctxpipe.ai for app.aws.ctxpipe.ai)
  const parts = domainName.split(".");
  const identity =
    parts.length > 2 ? parts.slice(1).join(".") : domainName;
  if (dryRun) {
    log(`[dry-run] would delete SES email identity ${identity}`);
    return;
  }
  log(`Deleting SES email identity ${identity}…`);
  try {
    await ses.send(new DeleteEmailIdentityCommand({ EmailIdentity: identity }));
  } catch (error) {
    const name = (error as { name?: string }).name;
    if (name === "NotFoundException") {
      log(`  SES identity already gone: ${identity}`);
      return;
    }
    throw error;
  }
}

async function verifyCostSensitiveGone(opts: {
  stackName: string;
  vpcId: string | undefined;
  rdsClusterIds: string[];
  neptuneClusterIds: string[];
}): Promise<string[]> {
  const problems: string[] = [];
  const ec2 = new EC2Client({ region: region() });
  const rds = new RDSClient({ region: region() });
  const neptune = new NeptuneClient({ region: region() });
  const elbv2 = new ElasticLoadBalancingV2Client({ region: region() });
  const ecs = new ECSClient({ region: region() });

  const nats = await ec2.send(
    new DescribeNatGatewaysCommand({
      Filter: [{ Name: "state", Values: ["available", "pending", "deleting"] }],
    }),
  );
  for (const nat of nats.NatGateways ?? []) {
    if (opts.vpcId && nat.VpcId === opts.vpcId) {
      problems.push(`NAT gateway still present: ${nat.NatGatewayId} (${nat.State})`);
    }
  }

  const rdsClusters = await rds.send(new DescribeDBClustersCommand({}));
  for (const cluster of rdsClusters.DBClusters ?? []) {
    const id = cluster.DBClusterIdentifier;
    if (!id) continue;
    if (
      opts.rdsClusterIds.includes(id) ||
      id.toLowerCase().includes(opts.stackName.toLowerCase())
    ) {
      problems.push(`RDS/Aurora cluster still present: ${id} (${cluster.Status})`);
    }
  }

  const neptuneClusters = await neptune.send(new DescribeNeptuneClustersCommand({}));
  for (const cluster of neptuneClusters.DBClusters ?? []) {
    const id = cluster.DBClusterIdentifier;
    if (!id) continue;
    if (opts.neptuneClusterIds.includes(id)) {
      problems.push(`Neptune cluster still present: ${id} (${cluster.Status})`);
    }
  }

  const lbs = await elbv2.send(new DescribeLoadBalancersCommand({}));
  for (const lb of lbs.LoadBalancers ?? []) {
    if (opts.vpcId && lb.VpcId === opts.vpcId) {
      problems.push(`ALB still present: ${lb.LoadBalancerName}`);
    }
  }

  const clusters = await ecs.send(new ListClustersCommand({}));
  for (const clusterArn of clusters.clusterArns ?? []) {
    if (!clusterArn.includes(opts.stackName)) continue;
    const services = await ecs.send(
      new ListServicesCommand({ cluster: clusterArn }),
    );
    if ((services.serviceArns ?? []).length === 0) continue;
    const described = await ecs.send(
      new DescribeServicesCommand({
        cluster: clusterArn,
        services: services.serviceArns,
      }),
    );
    for (const service of described.services ?? []) {
      if ((service.desiredCount ?? 0) > 0 || (service.runningCount ?? 0) > 0) {
        problems.push(
          `ECS service still active: ${service.serviceName} (desired=${service.desiredCount}, running=${service.runningCount})`,
        );
      }
    }
  }

  return problems;
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  const awsRegion = region();
  log(`Teardown target stack=${opts.stackName} region=${awsRegion} dryRun=${opts.dryRun}`);

  const cfn = new CloudFormationClient({ region: awsRegion });
  const efs = new EFSClient({ region: awsRegion });
  const rds = new RDSClient({ region: awsRegion });
  const neptune = new NeptuneClient({ region: awsRegion });
  const secrets = new SecretsManagerClient({ region: awsRegion });
  const logs = new CloudWatchLogsClient({ region: awsRegion });
  const ses = new SESv2Client({ region: awsRegion });

  let inventory: StackInventory = {
    efsIds: [],
    rdsClusterIds: [],
    neptuneClusterIds: [],
    secretArns: [],
    logGroupNames: [],
    lambdaNames: [],
    vpcId: undefined,
  };

  const exists = await stackExists(cfn, opts.stackName);
  if (exists) {
    log(`Capturing resources from live stack ${opts.stackName}…`);
    inventory = inventoryFromResources(
      await listAllStackResources(cfn, opts.stackName),
    );
  } else {
    log(`Stack ${opts.stackName} is not present; will purge orphans by name.`);
  }

  inventory.efsIds = await discoverRetainedEfs(efs, opts.stackName, inventory.efsIds);
  inventory.secretArns = await discoverSecretsForStack(
    secrets,
    opts.stackName,
    inventory.secretArns,
  );
  inventory.logGroupNames = await discoverOrphanLogGroups(
    logs,
    opts.stackName,
    inventory.logGroupNames,
  );

  log("Inventory:");
  log(`  EFS: ${inventory.efsIds.join(", ") || "(none)"}`);
  log(`  Aurora clusters: ${inventory.rdsClusterIds.join(", ") || "(none)"}`);
  log(`  Neptune clusters: ${inventory.neptuneClusterIds.join(", ") || "(none)"}`);
  log(`  Secrets: ${inventory.secretArns.length}`);
  log(`  Log groups: ${inventory.logGroupNames.length}`);
  log(`  VPC: ${inventory.vpcId ?? "(unknown)"}`);

  if (exists && !opts.skipDestroy) {
    await deleteCloudFormationStack(cfn, opts.stackName, opts.dryRun);
    if (!opts.dryRun) {
      await waitForStackDeleted(cfn, opts.stackName);
    }
  } else if (exists && opts.skipDestroy) {
    log("Skipping stack delete (--skip-destroy).");
  }

  for (const efsId of inventory.efsIds) {
    await deleteEfsFilesystem(efs, efsId, opts.dryRun);
  }

  await deleteRdsSnapshotsForClusters(rds, inventory.rdsClusterIds, opts.dryRun);
  await deleteNeptuneSnapshotsForClusters(
    neptune,
    inventory.neptuneClusterIds,
    opts.dryRun,
  );

  // Also delete any final snapshots whose identifier embeds the stack name
  // (covers destroys that already completed before this script captured IDs).
  if (inventory.rdsClusterIds.length === 0) {
    const snaps = await rds.send(new DescribeDBClusterSnapshotsCommand({}));
    for (const snap of snaps.DBClusterSnapshots ?? []) {
      const id = snap.DBClusterSnapshotIdentifier ?? "";
      const source = snap.DBClusterIdentifier ?? "";
      if (
        !id.toLowerCase().includes(opts.stackName.toLowerCase()) &&
        !source.toLowerCase().includes(opts.stackName.toLowerCase())
      ) {
        continue;
      }
      if (opts.dryRun) {
        log(`[dry-run] would delete RDS cluster snapshot ${id}`);
        continue;
      }
      log(`Deleting RDS cluster snapshot ${id}…`);
      await rds.send(
        new DeleteDBClusterSnapshotCommand({ DBClusterSnapshotIdentifier: id }),
      );
    }
  }

  for (const secretArn of inventory.secretArns) {
    await forceDeleteSecret(secrets, secretArn, opts.dryRun);
  }

  for (const logGroupName of inventory.logGroupNames) {
    await deleteLogGroup(logs, logGroupName, opts.dryRun);
  }

  if (opts.purgeSes) {
    await purgeSesIdentity(ses, opts.domainName, opts.dryRun);
  } else {
    log("Keeping SES identity (pass --purge-ses to remove).");
  }

  if (opts.dryRun) {
    log("Dry-run complete. Re-run without --dry-run to apply.");
    return;
  }

  const problems = await verifyCostSensitiveGone({
    stackName: opts.stackName,
    vpcId: inventory.vpcId,
    rdsClusterIds: inventory.rdsClusterIds,
    neptuneClusterIds: inventory.neptuneClusterIds,
  });
  if (problems.length > 0) {
    for (const problem of problems) log(`VERIFY FAIL: ${problem}`);
    process.exitCode = 1;
    return;
  }
  log("Teardown complete. Cost-sensitive resources look clear.");
  log("Kept: CDKToolkit bootstrap stack, Route53 hosted zone, SES identity (unless --purge-ses).");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
