import "./artifact-repository";
import "./config";
import "./network";
import "./database";
import "./compute";
import "./substrate";
import "./portal";
import "./directus";
import "./people-hub";
import "./run-reports-job";

// Exposed as a stack output (`pulumi stack output nameServers`) so the registrar delegation for
// each platform domain can be looked up after apply.
export { nameServers } from "./dns";

// The platform VM's static external IP — point DNS A records here as surfaces come online.
export { publicIp } from "./compute";
