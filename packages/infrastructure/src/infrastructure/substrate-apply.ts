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

// The Community role's id (directus-roles.ts) doesn't exist until this very apply has already
// succeeded once, so this can't be a plain `gcp.secretmanager.getSecretVersionOutput` read -
// without a real dependency to order against (there isn't one; that would cycle back to this
// resource), it would just fail outright on the deploy that first creates the role. A live shell
// probe sidesteps that the same way apply.sh's own fetch does, tolerant of no version existing
// yet. `local.runOutput`, not `local.Command`, so it re-reads the live value on every `pulumi up`
// rather than freezing whatever it saw once - that's what lets this trigger notice the role id
// going from unset to set and force the next apply to pick it up.
const communityRoleId = local.runOutput({
  command: `gcloud secrets versions access latest --project=${projectId} --secret=directus-community-role-id 2>/dev/null || true`,
});

/** `dependsOn: [instance, substrateImage]` - needs the VM to exist to SSH into, and the image
 * pushed before apply.sh tries to pull it. `../crm/`'s `DirectusSchema` needs this
 * reconciled too, but a stack boundary rules out a real `dependsOn` - apply order (infrastructure
 * first) is what guarantees it, with `waitForReachable` still the safety net. */
export const substrateApply = new local.Command(
  "substrate-apply",
  {
    create: sshCommand,
    update: sshCommand,
    stdin: payload,
    triggers: [composeContentHash, imageUrl, communityRoleId.stdout],
  },
  { dependsOn: [instance, substrateImage] },
);
