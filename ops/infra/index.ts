import type { Input } from "@pulumi/pulumi"
import type { ServiceRegion } from "@pulumi/railway/bin/types/input"
import * as pulumi from "@pulumi/pulumi"
import * as railway from "@pulumi/railway"
import * as neon from "@pulumi/neon"

const defaultRegions: Input<ServiceRegion>[] = [
  {
    numReplicas: 1,
    region: "us-east4-eqdc4a",
  },
]

const defaultConfig = {
  sourceRepo: "ctxpipe-ai/ctxpipe",
  sourceRepoBranch: "main",
}

const project = new railway.Project(
  "ctx-pipe",
  {
    defaultEnvironment: {
      name: "production",
    },
    description: "This is the ctx| application deployed as our SaaS platform",
    hasPrDeploys: true,
    name: "ctx| - app",
    private: true,
    workspaceId: "aa3ec44f-f8bd-4beb-bbe0-e4c46e20b14c",
  },
  {
    protect: true,
  },
)

const productionEnv = new railway.Environment(
  "production-env",
  {
    name: "production",
    projectId: project.id,
  },
  {
    protect: true,
  },
)

new railway.Service(
  "ui",
  {
    configPath: "/apps/ui/railway.json",
    name: "ctx| - ui",
    projectId: project.id,
    regions: defaultRegions,
    ...defaultConfig,
  },
  {
    protect: true,
  },
)

const backend = new railway.Service(
  "backend",
  {
    configPath: "/apps/backend/railway.json",
    name: "ctx| - backend",
    projectId: project.id,
    regions: defaultRegions,
    ...defaultConfig,
  },
  {
    protect: true,
  },
)

new railway.Service(
  "code-search",
  {
    configPath: "/apps/codesearch/railway.json",
    name: "CodeSearch",
    projectId: project.id,
    regions: defaultRegions,
    ...defaultConfig,
    volume: {
      mountPath: "/data",
      name: "codesearch-volume-vNK-",
    },
  },
  {
    protect: true,
  },
)

new railway.Service(
  "openWorkflow",
  {
    configPath: "/apps/backend/railway.worker.json",
    name: "OpenWorkflow",
    projectId: project.id,
    regions: defaultRegions,
    ...defaultConfig,
  },
  {
    protect: true,
  },
)

const falkorDb = new railway.Service(
  "falkorDb",
  {
    name: "FalkorDB",
    projectId: project.id,
    regions: defaultRegions,
    sourceImage: "falkordb/falkordb",
    volume: {
      mountPath: "/var/lib/falkordb/data",
      name: "falkordb-volume",
    },
  },
  {
    protect: true,
  },
)

const falkorDbPortVariable = new railway.Variable("falkorDbPort", {
  name: "FALKORDB_PORT",
  environmentId: productionEnv.id,
  serviceId: falkorDb.id,
  value: "6379",
})

new railway.Variable("graphDbUrl", {
  name: "GRAPH_DB_URI",
  environmentId: productionEnv.id,
  serviceId: backend.id,
  value: pulumi.interpolate`redis://falkordb:${falkorDbPortVariable.value}`,
})

new neon.Project(
  "neonProject",
  {
    branch: {
      databaseName: "neondb",
      name: "production",
      roleName: "neondb_owner",
    },
    computeProvisioner: "k8s-neonvm",
    defaultEndpointSettings: {
      autoscalingLimitMaxCu: 8,
      autoscalingLimitMinCu: 0.25,
    },
    historyRetentionSeconds: 86400,
    maintenanceWindow: {
      endTime: "10:00",
      startTime: "09:00",
      weekdays: [5],
    },
    name: "ctxpipe",
    orgId: "org-steep-pine-64462726",
    pgVersion: 17,
    regionId: "aws-us-east-1",
    storePassword: "yes",
  },
  {
    protect: true,
  },
)
