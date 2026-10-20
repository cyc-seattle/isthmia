import * as command from "@pulumi/command";
import { WebService } from "@cyc-seattle/platform";
import { appImage, loadCluster, onCluster } from "../cluster";

// The portal on the cluster (#231): Caddy and the built site, with `forward_auth` to the
// `authentik-server` Service in the same namespace (packages/portal/Dockerfile).

export = async () => {
  if (!onCluster()) {
    return {};
  }
  const cluster = await loadCluster();
  const { platform, provider } = cluster;

  const image = appImage(cluster, "portal", { context: "../../../..", dockerfile: "../../../portal/Dockerfile" });

  const portal = new WebService("portal", {
    platform,
    provider,
    hostname: platform.domain,
    image: image.ref,
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

  // The load balancer serves its own 404 for minutes until it admits a new route. `/` answers 302
  // to sign-in once both the route and Authentik's outpost are up.
  new command.local.Command(
    "portal-ready",
    {
      create: 'curl -fsS -o /dev/null --retry 90 --retry-delay 10 --retry-all-errors "$PORTAL_URL"',
      environment: { PORTAL_URL: portal.url },
      triggers: [image.ref],
    },
    { dependsOn: portal },
  );

  return { url: portal.url };
};
