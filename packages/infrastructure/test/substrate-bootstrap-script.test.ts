import { describe, it, expect } from "vitest";
import {
  bootstrapScript,
  remoteApplyPayload,
  remoteSshCommand,
  substrateFiles,
  type BootstrapScriptParams,
  type CloudConfigParams,
} from "../src/substrate-bootstrap-script.js";

function makeParams(overrides: Partial<BootstrapScriptParams> = {}): BootstrapScriptParams {
  return {
    image: "us-west1-docker.pkg.dev/proj/repo/substrate:latest",
    directusDbHost: "10.0.0.5",
    projectId: "cyc-admin-scripts",
    siteDomain: "internal.example.com",
    directusDomain: "directus.internal.example.com",
    authGroup: "all@cyccommunitysailing.org",
    authAdminEmail: "master@cyccommunitysailing.org",
    directusAdminEmail: "master@cyccommunitysailing.org",
    registryHost: "us-west1-docker.pkg.dev",
    composeProjectName: "substrate",
    ...overrides,
  };
}

function makeCloudConfigParams(overrides: Partial<CloudConfigParams> = {}): CloudConfigParams {
  return { ...makeParams(), composeContent: "services:\n  caddy:\n    image: x\n", ...overrides };
}

describe("bootstrapScript", () => {
  it("removes containers publishing host port 80 or 443 that aren't ours, before pulling/starting this project", () => {
    const script = bootstrapScript(makeParams());

    const cleanupIndex = script.indexOf('"$project" != "substrate"');
    const pullIndex = script.indexOf("docker-compose.yml pull");
    expect(cleanupIndex).toBeGreaterThan(-1);
    expect(pullIndex).toBeGreaterThan(-1);
    expect(cleanupIndex).toBeLessThan(pullIndex);

    // Scoped to host port 80/443, not the compose-project label alone (#100) - a foreign-labeled
    // container publishing neither port must never be touched.
    expect(script).toContain('*" 80 "*|*" 443 "*)');
    expect(script).toContain('if [ "$project" != "substrate" ]; then docker rm -f "$cid" || true; fi');
  });

  it("scopes the cleanup to whatever the project's own compose-project name is", () => {
    const script = bootstrapScript(makeParams({ composeProjectName: "some-other-project" }));

    expect(script).toContain('"$project" != "some-other-project"');
    expect(script).not.toContain('"$project" != "substrate"');
  });

  it("looks up published host ports via `docker inspect`, not `docker ps --filter publish=`", () => {
    // The `publish=` filter isn't universally supported (podman's docker shim rejects it).
    const script = bootstrapScript(makeParams());
    expect(script).not.toContain("--filter publish=");
    expect(script).toContain(".NetworkSettings.Ports");
  });
});

describe("remoteApplyPayload", () => {
  it("writes all three substrateFiles atomically (tmp file + mv) and activates the unit", () => {
    const params = makeCloudConfigParams();
    const payload = remoteApplyPayload(params);

    for (const file of substrateFiles(params)) {
      expect(payload).toContain(`cat > ${file.path}.new <<'`);
      expect(payload).toContain(`mv ${file.path}.new ${file.path}`);
      expect(payload).toContain(`chmod ${file.permissions} ${file.path}.new`);
    }
    expect(payload).toContain("systemctl daemon-reload");
    expect(payload).toContain("systemctl enable substrate-apply.service");
    expect(payload).toContain("systemctl start --wait substrate-apply.service");
  });

  it("carries no secret values - only file contents that fetch secrets themselves at run time", () => {
    const payload = remoteApplyPayload(makeCloudConfigParams());
    // This payload lands in Pulumi state - every secret var must come from a fetch_secret call.
    for (const key of [
      "GOOGLE_OAUTH_CLIENT_ID",
      "GOOGLE_OAUTH_CLIENT_SECRET",
      "OAUTH2_PROXY_COOKIE_SECRET",
      "DIRECTUS_KEY",
      "DIRECTUS_SECRET",
      "DIRECTUS_DB_PASSWORD",
      "DIRECTUS_ADMIN_PASSWORD",
    ]) {
      expect(payload).toMatch(new RegExp(`${key}=\\$\\(fetch_secret`));
    }
  });
});

describe("remoteSshCommand", () => {
  const commandParams = { instanceName: "substrate-abc123", zone: "us-west1-b", projectId: "cyc-admin-scripts" };

  it("retries the IAP SSH connection before giving up, then pipes stdin into `sudo bash -s`", () => {
    const command = remoteSshCommand(commandParams);
    expect(command).toContain("--tunnel-through-iap");
    expect(command).toContain("substrate-abc123");
    expect(command).toContain("--zone=us-west1-b");
    expect(command).toContain("--project=cyc-admin-scripts");
    expect(command).toContain('--command="sudo bash -s"');
    expect(command).toMatch(/until gcloud compute ssh/); // retries, not a single attempt
    expect(command).toContain("sleep 5");
  });
});
