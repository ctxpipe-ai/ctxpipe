import type { Input } from "@pulumi/pulumi";
import * as railway from "@pulumi/railway";
import type { ServiceRegion } from "@pulumi/railway/bin/types/input";

const defaultRegions: Input<ServiceRegion>[] = [
  {
    numReplicas: 1,
    region: "us-east4-eqdc4a",
  },
];

const defaultConfig = {
  sourceRepo: "ctxpipe-ai/ctxpipe",
  sourceRepoBranch: "main",
};

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
);

new railway.Environment(
  "production-env",
  {
    name: "production",
    projectId: project.id,
  },
  {
    protect: true,
  },
);

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
);

new railway.Service(
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
);

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
);

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
);

new railway.Service(
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
);