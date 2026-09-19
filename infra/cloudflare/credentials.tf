# PlanetScale role credentials, kept in the Terraform state (the user's
# decision; docs/deployment-pipeline.md#role-credentials-in-the-state).
#
# A role's password is shown only when the role is created or reset. The
# deploy's bootstrap step passes it once, as a TF_VAR, and each resource below
# stores the first value it is given: `ignore_changes = [input]` keeps it on
# every later run, when the variable is empty. A new value is taken only when
# the resource is replaced (`-replace=`, which the deploy adds when the role
# was created or reset in the same run).
#
# The `.input` attribute is read, not `.output`: with ignore_changes its
# planned value is known during the plan (the stored value, or the new one on
# a create or replace), so the precondition below fails the plan, before
# anything is applied, when there is nothing to use.
#
# The state (private R2 bucket, backed up before every apply) is therefore the
# only copy of both credentials. Losing it means restoring a backup or
# resetting both roles.

resource "terraform_data" "planetscale_runtime_password" {
  input = var.planetscale_runtime_password

  lifecycle {
    ignore_changes = [input]
  }
}

resource "terraform_data" "migration_database_url" {
  input = var.migration_database_url

  lifecycle {
    ignore_changes = [input]
  }
}

locals {
  runtime_password       = terraform_data.planetscale_runtime_password.input
  migration_database_url = terraform_data.migration_database_url.input

  # The PostgreSQL database name is not secret; it is the path of the stored
  # migration URL, so later runs keep the name the role was created with.
  database_from_migration_url = nonsensitive(try(regex("^[a-z]+://[^/]+/([^?]+)", local.migration_database_url)[0], ""))
  origin_database = (
    var.hyperdrive_origin_database != "" ? var.hyperdrive_origin_database :
    local.database_from_migration_url != "" ? local.database_from_migration_url :
    "postgres"
  )
}
