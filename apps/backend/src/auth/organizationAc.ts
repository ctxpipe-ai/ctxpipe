import { createAccessControl } from "better-auth/plugins/access"
import { defaultStatements } from "better-auth/plugins/organization/access"

/** Extended default org statements + apiKey CRUD for organization-owned API keys (Better Auth api-key plugin). */
export const organizationStatements = {
  ...defaultStatements,
  apiKey: ["create", "read", "update", "delete"],
} as const

export const organizationAc = createAccessControl(organizationStatements)

/** Mirrors Better Auth default owner/admin/member roles with apiKey permissions added. */
export const organizationRoles = {
  owner: organizationAc.newRole({
    organization: ["update", "delete"],
    member: ["create", "update", "delete"],
    invitation: ["create", "cancel"],
    team: ["create", "update", "delete"],
    ac: ["create", "read", "update", "delete"],
    apiKey: ["create", "read", "update", "delete"],
  }),
  admin: organizationAc.newRole({
    organization: ["update"],
    invitation: ["create", "cancel"],
    member: ["create", "update", "delete"],
    team: ["create", "update", "delete"],
    ac: ["create", "read", "update", "delete"],
    apiKey: ["create", "read", "update", "delete"],
  }),
  member: organizationAc.newRole({
    organization: [],
    member: [],
    invitation: [],
    team: [],
    ac: ["read"],
    apiKey: ["read"],
  }),
}
