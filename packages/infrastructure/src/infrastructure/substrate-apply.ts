import { createHash } from "node:crypto";
import { local } from "@pulumi/command";
import { projectId } from "../config";
import { instance, zone } from "./compute";
import { substrateImage } from "./substrate";
import { imageUrl, substrateParams } from "./substrate-bootstrap";
import { remoteApplyPayload, remoteSshCommand } from "./substrate-bootstrap-script";

// Pulumi resource that reconciles the substrate VM's compose stack over IAP SSH on every
// `pulumi up`, not just on a VM's first boot (#107) - see substrate-bootstrap-script.ts's
// remoteApplyPayload/remoteSshCommand for what actually runs.

const payload = substrateParams.apply((params) => remoteApplyPayload(params));

const sshCommand = instance.name.apply((instanceName) => remoteSshCommand({ instanceName, zone, projectId }));

// Hashed so the trigger array (which lands in the Pulumi diff) stays short.
const composeContentHash = substrateParams.apply((params) =>
  createHash("sha256").update(params.composeContent).digest("hex"),
);

/** `dependsOn: [instance, substrateImage]` - needs the VM to exist to SSH into, and the image
 * pushed before apply.sh tries to pull it. `../people-hub/`'s `DirectusSchema` needs this
 * reconciled too, but a stack boundary rules out a real `dependsOn` - apply order (infrastructure
 * first) is what guarantees it, with `waitForReachable` still the safety net. */
export const substrateApply = new local.Command(
  "substrate-apply",
  {
    create: sshCommand,
    update: sshCommand,
    stdin: payload,
    triggers: [composeContentHash, imageUrl],
  },
  { dependsOn: [instance, substrateImage] },
);
