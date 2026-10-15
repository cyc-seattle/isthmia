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

  return { url: portal.url };
};
