import { describe, it, expect } from "vitest";
import {
  bootstrapScript,
  cloudConfig,
  remoteApplyPayload,
  remoteSshCommand,
  substrateApplyUnit,
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

    // Scoped to host port 80/443, not to the compose-project label alone (#100's rule, which #107
    // narrows) - a foreign-labeled container that publishes neither port must never be considered,
    // regardless of what `$project` resolves to.
    expect(script).toContain('*" 80 "*|*" 443 "*)');
    expect(script).toContain('if [ "$project" != "substrate" ]; then docker rm -f "$cid" || true; fi');
  });

  it("scopes the cleanup to whatever the project's own compose-project name is", () => {
    const script = bootstrapScript(makeParams({ composeProjectName: "some-other-project" }));

    expect(script).toContain('"$project" != "some-other-project"');
    expect(script).not.toContain('"$project" != "substrate"');
  });

  it("looks up published host ports via `docker inspect`, not `docker ps --filter publish=`", () => {
    // `docker ps --filter publish=` isn't implemented by every docker-compatible CLI (confirmed:
    // podman's docker shim rejects it outright) - the inspect-based form below is standard
    // `docker inspect` Go-template output on any Docker Engine, so it works everywhere.
    const script = bootstrapScript(makeParams());
    expect(script).not.toContain("--filter publish=");
    expect(script).toContain(".NetworkSettings.Ports");
  });
});

describe("substrateApplyUnit", () => {
  it("is a oneshot unit with no RemainAfterExit, running apply.sh, enabled at boot", () => {
    expect(substrateApplyUnit).toContain("Type=oneshot");
    expect(substrateApplyUnit).not.toContain("RemainAfterExit");
    expect(substrateApplyUnit).toContain("ExecStart=/var/substrate/apply.sh");
    expect(substrateApplyUnit).toContain("WantedBy=multi-user.target");
  });
});

describe("substrateFiles", () => {
  it("describes the compose file, apply.sh, and the systemd unit - and only those three", () => {
    const files = substrateFiles(makeCloudConfigParams());
    expect(files.map((f) => f.path)).toEqual([
      "/var/substrate/docker-compose.yml",
      "/var/substrate/apply.sh",
      "/etc/systemd/system/substrate-apply.service",
    ]);
    expect(files[0]?.content).toBe(makeCloudConfigParams().composeContent);
    expect(files[1]?.content).toBe(bootstrapScript(makeParams()));
    expect(files[2]?.content).toBe(substrateApplyUnit);
  });
});

describe("cloudConfig", () => {
  it("writes all three substrateFiles and enables+starts the unit via runcmd", () => {
    const config = cloudConfig(makeCloudConfigParams());
    expect(config).toContain("path: /var/substrate/docker-compose.yml");
    expect(config).toContain("path: /var/substrate/apply.sh");
    expect(config).toContain("path: /etc/systemd/system/substrate-apply.service");
    expect(config).toContain("['systemctl', 'daemon-reload']");
    expect(config).toContain("['systemctl', 'enable', 'substrate-apply.service']");
    expect(config).toContain("['systemctl', 'start', '--wait', 'substrate-apply.service']");
    // No longer directly executing bootstrap.sh from runcmd (#107) - the systemd unit is the only
    // entry point, so both cloud-init and a later Pulumi remote-exec go through the same path.
    expect(config).not.toContain("/bin/bash', '/var/substrate/bootstrap.sh");
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
    // Every secret-bearing env var is assigned from a `fetch_secret` call executed later, on the
    // VM - never a literal value baked in by this (Pulumi-state-recorded) payload.
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
    // A retry loop, not a single attempt - OS Login/IAP tunnel setup on a brand-new or just-replaced
    // VM isn't instant.
    expect(command).toMatch(/until gcloud compute ssh/);
    expect(command).toContain("sleep 5");
  });

  it("disables host-key checking, since a replaced VM reuses its IP with a new host key", () => {
    const command = remoteSshCommand(commandParams);
    expect(command).toContain("StrictHostKeyChecking=no");
    expect(command).toContain("UserKnownHostsFile=/dev/null");
  });
});
