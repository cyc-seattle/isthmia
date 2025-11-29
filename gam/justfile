default:
    @just --list



# Login as the admin user.
auth:
    gam oauth create ${GAM_ADMIN_USER}
    gam info domain


# Export group information to the spreadsheet
export:
    ./scripts/export-groups
    ./scripts/export-group-members