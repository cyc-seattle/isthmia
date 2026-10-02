import { describe, it, expect } from "vitest";
import {
  bootstrapScript,
  remoteApplyPayload,
  remoteSshCommand,
  substrateFiles,
  type BootstrapScriptParams,
  type CloudConfigParams,
} from "../src/infrastructure/substrate-bootstrap-script.js";

function makeParams(overrides: Partial<BootstrapScriptParams> = {}): BootstrapScriptParams {
  return {
    image: "us-west1-docker.pkg.dev/proj/repo/substrate:latest",
    directusDbHost: "10.0.0.5",
    projectId: "cyc-admin-scripts",
    siteDomain: "internal.example.com",
    directusDomain: "directus.internal.example.com",
    loginDomain: "login.internal.example.com",
    directusAdminEmail: "master@cyccommunitysailing.org",
    registryHost: "us-west1-docker.pkg.dev",
    composeProjectName: "substrate",
    ...overrides,
  };
}

function makeCloudConfigParams(overrides: Partial<CloudConfigParams> = {}): CloudConfigParams {
  return {
    ...makeParams(),
    composeContent: "services:\n  caddy:\n    image: x\n",
    authentikTemplates: [{ name: "sign-in.html", content: "<p>{{ url }}</p>" }],
    ...overrides,
  };
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

  it("brings the stack up with --remove-orphans, so a service dropped from compose stops running", () => {
    const script = bootstrapScript(makeParams());
    expect(script).toContain("docker-compose.yml up -d --remove-orphans");
  });

  it("writes LOGIN_DOMAIN and Authentik's secrets into the env file, and checks they're non-empty", () => {
    const script = bootstrapScript(makeParams({ loginDomain: "login.internal.example.com" }));

    expect(script).toContain("LOGIN_DOMAIN=login.internal.example.com");
    for (const key of [
      "AUTHENTIK_SECRET_KEY",
      "AUTHENTIK_DB_PASSWORD",
      "AUTHENTIK_BOOTSTRAP_TOKEN",
      "AUTHENTIK_BOOTSTRAP_PASSWORD",
    ]) {
      expect(script).toMatch(new RegExp(`${key}=\\$\\(fetch_secret`));
    }
    const checkLoopIndex = script.indexOf("for key in");
    expect(script.slice(checkLoopIndex)).toContain("AUTHENTIK_SECRET_KEY AUTHENTIK_DB_PASSWORD");
  });

  it("fetches the Directus OIDC client secret and checks it's non-empty", () => {
    const script = bootstrapScript(makeParams());
    expect(script).toMatch(/DIRECTUS_OIDC_CLIENT_SECRET=\$\(fetch_secret directus-oidc-client-secret\)/);
    const checkLoopIndex = script.indexOf("for key in");
    expect(script.slice(checkLoopIndex)).toContain("DIRECTUS_OIDC_CLIENT_SECRET");
  });

  it("tolerates a 404 fetching the Community role's id - it may not exist yet", () => {
    const script = bootstrapScript(makeParams());
    expect(script).toContain("404) DIRECTUS_COMMUNITY_ROLE_ID= ;;");
    // Not in the strict non-empty check: unlike every other secret below, blank is a legitimate
    // state for this one, not just a tolerated fetch outcome.
    const checkLoopIndex = script.indexOf("for key in");
    expect(script.slice(checkLoopIndex)).not.toContain("DIRECTUS_COMMUNITY_ROLE_ID");
  });

  it("fails loudly if fetching the Community role's id returns anything but 200 or 404", () => {
    const script = bootstrapScript(makeParams());
    const caseIndex = script.indexOf('case "$COMMUNITY_ROLE_STATUS" in');
    expect(caseIndex).toBeGreaterThan(-1);
    const caseBlock = script.slice(caseIndex, script.indexOf("esac", caseIndex));
    expect(caseBlock).toContain("200) DIRECTUS_COMMUNITY_ROLE_ID=$(fetch_secret directus-community-role-id) ;;");
    expect(caseBlock).toMatch(/\*\).*exit 1/);
  });
});

describe("substrateFiles", () => {
  it("writes each Authentik template under authentik-templates/email, keyed by its own name", () => {
    const files = substrateFiles(
      makeCloudConfigParams({
        authentikTemplates: [
          { name: "sign-in.html", content: "<p>sign in</p>" },
          { name: "enrollment-verification.html", content: "<p>verify</p>" },
        ],
      }),
    );

    expect(files).toContainEqual({
      path: "/var/substrate/authentik-templates/email/sign-in.html",
      permissions: "0644",
      content: "<p>sign in</p>",
    });
    expect(files).toContainEqual({
      path: "/var/substrate/authentik-templates/email/enrollment-verification.html",
      permissions: "0644",
      content: "<p>verify</p>",
    });
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
      "DIRECTUS_KEY",
      "DIRECTUS_SECRET",
      "DIRECTUS_DB_PASSWORD",
      "DIRECTUS_ADMIN_PASSWORD",
      "AUTHENTIK_SECRET_KEY",
      "AUTHENTIK_DB_PASSWORD",
      "AUTHENTIK_BOOTSTRAP_TOKEN",
      "AUTHENTIK_BOOTSTRAP_PASSWORD",
      "DIRECTUS_OIDC_CLIENT_SECRET",
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
