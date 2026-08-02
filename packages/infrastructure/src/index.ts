import "./artifact-repository";
import "./config";
import "./network";
import "./database";
import "./run-reports-job";

// Exposed as a stack output (`pulumi stack output nameServers`) so the registrar delegation for
// each platform domain can be looked up after apply.
export { nameServers } from "./dns";
