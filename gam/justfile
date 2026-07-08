gam_config_dir := env("GAM_CONFIG_DIR", "~/.config/gam")

default:
    @just --list

# Use the existing GAM project.
use-project:
    gam use project \
        admin "${GAM_ADMIN_USER}" \
        project "${GAM_PROJECT_ID}" \
        saname "${GAM_SERVICE_ACCOUNT_NAME}"

# Verify the service account has the required API scopes.
check:
    gam user "${GAM_ADMIN_USER}" check serviceaccount

# Login as the admin user.
auth:
    gam oauth create "${GAM_ADMIN_USER}"
    gam info domain

# Export group information to the spreadsheet
export:
    ./scripts/export-groups
    ./scripts/export-group-members