import "./artifact-repository";
import "../config";
import "./network";
import "./compute";
import "./substrate-apply";
import "./substrate";
import "./portal";
import "./directus";
import "./authentik";
import "./clubspot-sync-job";
import "./gsuite-sync-job";
import { enableService } from "../services";

// The other prod projects' resources need these, and their state moved from here (#231). A second
// enableService in another project would be a second resource for the same API.
enableService("secretmanager.googleapis.com");
enableService("sqladmin.googleapis.com");

// So a separate app project (../authentik) can build its own hostnames without a second Pulumi
// config declaring the same domain.
export { internalDomain } from "./dns";

// The platform VM's static external IP — point DNS A records here as surfaces come online.
export { publicIp } from "./compute";

// Every API call a separate app project makes resolves through here.
export { directusBaseUrl } from "./directus";
