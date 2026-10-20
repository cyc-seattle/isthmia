import * as gcp from "@pulumi/gcp";
import { crmIdentities } from "../directus";
import { auth, directusDatabase, clubspotSyncDirectusToken, gsuiteSyncDirectusToken } from "./directus";
import { substrateApply } from "./substrate-apply";
import { substrateRunner } from "./identities";
import { externalDomain } from "./dns";
import { requireStringList } from "../config";
import { Secret } from "./secret";
import { enableService } from "../services";

// The identity layer for Directus-backed apps: roles/policies and the users assigned to them, from
// ../directus/roles.ts, which ../crm also declares on the cluster. Outlives any one app (see #65)
// and is kept out of ../crm/ in prod until its state moves there (#231).

// Same two edges crmSchema depends on (substrateApply for a reconciled Directus container,
// directusDatabase for Directus owning its DB) rather than a dependency on crmSchema itself:
// a role/policy is collection-agnostic, so it doesn't need the schema applied first. The
// collection-referencing permission rules that do need the schema declare that dependency
// themselves, in ../crm/.
export const { staffRole, coachRole, guardianRole, communityRole, clubspotSyncRole, gsuiteSyncRole } = crmIdentities({
  auth,
  readyForApiCalls: [substrateApply, directusDatabase],
  admins: requireStringList("directusAdmins"),
  externalDomain,
  clubspotSyncToken: clubspotSyncDirectusToken.value,
  gsuiteSyncToken: gsuiteSyncDirectusToken.value,
});

// Directus only assigns the role's id once it exists, and creating it needs substrateApply to have
// already stood Directus up (readyForApiCalls above) - so the id can't flow back into
// substrate-bootstrap.ts's params as a plain Pulumi Output without making substrateApply depend on
// a role that itself depends on substrateApply. Routed through Secret Manager instead:
// substrate-bootstrap-script.ts's apply.sh fetches it live, by name, the same way it already
// fetches every other Directus env value, tolerating only a 404 (no version yet) on the one deploy
// that creates this role. substrate-apply.ts's own trigger on this secret's live value (not just
// compose/image changes) is what forces that next apply, not just "whenever one happens to run".
const communityRoleIdSecret = new Secret("directus-community-role-id", {
  dependsOn: enableService("secretmanager.googleapis.com"),
});
communityRoleIdSecret.grant(substrateRunner.member, "substrate-runner");
new gcp.secretmanager.SecretVersion("directus-community-role-id-version", {
  secret: communityRoleIdSecret.id,
  secretData: communityRole.roleId,
});
