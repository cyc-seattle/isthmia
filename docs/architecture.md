# Architecture

The architecture of CYC's platform as a whole, from the cluster and database to the CRM, the syncs, and the roadmap,
moved to [platform's architecture doc](https://github.com/cyc-seattle/platform/blob/main/docs/architecture.md).

This repo deploys two apps onto platform's cluster:

- **Authentik**, at `login.cycsail.team`, is the sign-in for everyone: staff, coaches, and guardians, through Google or
  an emailed link. Directus signs users in through it by OIDC. Its forward-auth outpost gates apps with no sign-in of
  their own, such as the portal.
- **The portal**, at `cycsail.team`, gives staff and volunteers one bookmark for their tools. Caddy serves it, behind
  Authentik's outpost.

[AGENTS.md](../AGENTS.md) covers how they deploy.
