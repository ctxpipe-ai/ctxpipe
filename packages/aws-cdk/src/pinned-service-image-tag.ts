/**
 * GHCR image tag shared by backend, worker, UI, codesearch, and migrate tasks.
 * Intentionally not configurable via {@link CtxPipeProps} so CDK-defined infra
 * cannot drift from the container images this construct expects.
 */
// Updated by release CI to the commit SHA associated with the published package.
export const PINNED_SERVICE_IMAGE_TAG =
  "35474e9a87e6bb9a9e0e64e4629678440408f589" as const;
