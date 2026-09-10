import { createHash } from "node:crypto";
import { local } from "@pulumi/command";
import { location, projectId } from "./config";
import { instance } from "./compute";
import { substrateImage } from "./substrate";
import { imageUrl, substrateParams } from "./substrate-bootstrap";
import { remoteApplyPayload, remoteSshCommand } from "./substrate-bootstrap-script";

// The "update" counterpart to substrate-bootstrap.ts's cloud-init: a Pulumi resource that
// reconciles the substrate VM's compose stack with the current program state on every `pulumi up`,
// not just on a VM's first boot (#107). Runs entirely over IAP-tunneled SSH via the deployer's own
// `gcloud` credentials — the same mechanism used by hand today (compute.ts already grants
// deployers `roles/iap.tunnelResourceAccessor` + `roles/compute.osLogin`) — rather than standing up
// separate SSH-key machinery, which was the right call to reject for #99 and remains right here.
//
// No secret values ever appear in this resource's inputs (`create`/`update`/`stdin`, all recorded
// in Pulumi state): the payload is the compose file, apply.sh's script text, and the systemd unit —
// apply.sh fetches actual secret values itself, at run time, directly from Secret Manager using the
// VM's own instance identity token. Keep it that way — see remoteApplyPayload's doc comment.

const zone = `${location}-b`;

const payload = substrateParams.apply((params) => remoteApplyPayload(params));

const sshCommand = instance.name.apply((instanceName) => remoteSshCommand({ instanceName, zone, projectId }));

// A hash, not the raw compose text, so the trigger array itself (which lands in the diff Pulumi
// prints) stays short; `imageUrl` alongside it means an image-only bump (no compose edit) also
// re-triggers.
const composeContentHash = substrateParams.apply((params) =>
  createHash("sha256").update(params.composeContent).digest("hex"),
);

/** Reconciles the substrate VM's compose stack (and the systemd unit that runs it) with the
 * program's current `substrateParams` — first applied right after the VM itself is created, and
 * re-applied whenever the compose content or image tag changes. `dependsOn: [instance,
 * substrateImage]`: needs the VM to exist to SSH into it, and needs the image actually pushed
 * before `apply.sh` tries to pull it — cloud-init's own first-boot path has this same ordering gap
 * against a fresh deploy (pre-existing, out of scope here), but there's no reason for this new path
 * to share it when the dependency is easy to state explicitly.
 * `DirectusSchema`/`DirectusRole`/`DirectusUser` (directus.ts/people-hub.ts) depend on this too, so
 * they no longer race VM boot through `waitForReachable`'s retry loop alone — that loop is now a
 * safety net for container startup time, not the primary synchronization (see #107). */
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
