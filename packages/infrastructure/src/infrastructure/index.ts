import "./artifact-repository";
import "../config";
import "./network";
import "./database";
import "./compute";
import "./substrate-apply";
import "./substrate";
import "./portal";
import "./directus";
import { staffRole, coachRole, guardianRole } from "./directus-roles";
import "./people-hub";
import "./run-reports-job";

// Exposed as a stack output (`pulumi stack output nameServers`) so the registrar delegation for
// each platform domain can be looked up after apply.
export { nameServers } from "./dns";

// The platform VM's static external IP — point DNS A records here as surfaces come online.
export { publicIp } from "./compute";

// Every API call a separate app project makes resolves through here.
export { directusBaseUrl } from "./directus";

// So a separate app project can attach its own permission rules to these policies without owning
// (or being able to clobber) the role itself.
export const staffPolicyId = staffRole.policyId;
export const coachPolicyId = coachRole.policyId;
export const guardianPolicyId = guardianRole.policyId;
