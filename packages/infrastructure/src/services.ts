import * as gcp from "@pulumi/gcp";

const enabled = new Map<string, gcp.projects.Service>();

/**
 * Enables a Google Cloud API, memoized so repeated calls for the same API return the same resource.
 * Returns the {@link gcp.projects.Service} so the resources that need the API can `dependsOn` it and
 * therefore be created only after it is enabled. Enable each API from the file that uses it, rather
 * than maintaining a central list.
 */
export function enableService(service: string): gcp.projects.Service {
  const existing = enabled.get(service);
  if (existing) {
    return existing;
  }

  const svc = new gcp.projects.Service(`enable-${service}`, {
    service,
    // Leave the API enabled if the resource is torn down — other things may rely on it.
    disableOnDestroy: false,
  });
  enabled.set(service, svc);
  return svc;
}
