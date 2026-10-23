import * as command from "@pulumi/command";
import * as pulumi from "@pulumi/pulumi";
import { WebService } from "@cyc-seattle/platform";
import { deployedImage, isDev, loadCluster, onCluster } from "../cluster";
import { dnsRecord, vmDnsRecord } from "../vm";

// The portal on the cluster (#231): Caddy and the built site, with `forward_auth` to the
// `authentik-server` Service in the same namespace (packages/portal/Dockerfile).

export = async () => {
  if (!onCluster()) {
    // The VM serves prod's apex. Its record moved here from `infrastructure` (scripts/move-portal-state).
    if (!isDev) {
      vmDnsRecord("portal-a");
    }
    return {};
  }
  const cluster = await loadCluster();
  const { platform, provider } = cluster;

  const image = deployedImage(cluster, "portal", {
    context: "../../../..",
    dockerfile: "../../../portal/Dockerfile",
  });

  const replicas = new pulumi.Config().getNumber("replicas") ?? 1;
  const portal = new WebService("portal", {
    platform,
    provider,
    // So an Autopilot node move never takes the site down (#253).
    replicas,
    ...(replicas > 1 && { minAvailable: 1, spreadAcrossZones: true }),
    hostname: platform.domain,
    image,
    port: 8080,
    requests: { cpu: "50m", memory: "128Mi" },
    // Public, so the load balancer's health check passes without a sign-in.
    readinessProbe: { httpGet: { path: "/welcome", port: 8080 } },
    // Caddy's XDG_DATA_HOME and XDG_CONFIG_HOME. It writes nothing else.
    volumes: [
      { name: "data", mountPath: "/data", emptyDir: {} },
      { name: "config", mountPath: "/config", emptyDir: {} },
    ],
  });

  // Dev's apex is under platform's records.
  const record = isDev ? [] : [dnsRecord("portal-a", platform.domain, platform.gatewayAddress)];

  // The load balancer serves its own 404 for minutes until it admits a new route. `/` answers 302
  // to sign-in once both the route and Authentik's outpost are up.
  new command.local.Command(
    "portal-ready",
    {
      create: 'curl -fsS -o /dev/null --retry 90 --retry-delay 10 --retry-all-errors "$PORTAL_URL"',
      environment: { PORTAL_URL: portal.url },
      triggers: [image],
    },
    { dependsOn: [portal, ...record] },
  );

  return { url: portal.url };
};
