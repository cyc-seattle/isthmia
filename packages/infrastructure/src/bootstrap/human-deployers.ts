import { requireStringList } from "../config";

// IAM members, such as `user:<email>`. Project Owner doesn't cover OS Login for a principal outside
// the org (docs/manual-setup.md §7), so they need the grants here even though deploy-runner has them.
export const humanDeployers = requireStringList("humanDeployers");
