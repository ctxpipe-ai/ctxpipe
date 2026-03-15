import * as railway from "@pulumi/railway";

const ctxpipeProject = new railway.Project("ctxpipe", {
  name: "ctx|",
});

const backendService = new railway.Service("backend", {
  projectId: ctxpipeProject.id,
  name: "backend",
})

export const railwayProjectId = ctxpipeProject.id;
export const railwayProjectName = ctxpipeProject.name;
