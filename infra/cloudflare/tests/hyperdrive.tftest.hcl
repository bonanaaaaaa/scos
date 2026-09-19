# Offline checks of the Hyperdrive configuration: `terraform test` with a
# mocked provider, so no credential or account is needed (infra-check.yml).

mock_provider "cloudflare" {}

variables {
  cloudflare_account_id  = "0123456789abcdef0123456789abcdef"
  environment            = "prod"
  planetscale_host       = "example.ap-southeast.psdb.cloud"
  hyperdrive_origin_user = "scos_runtime.example"

  # Fresh credentials, as the deploy passes them on a first run. The runs
  # under "Role credentials" override them.
  planetscale_runtime_password = "not-a-real-password"
  migration_database_url       = "postgresql://scos_migrator.example:pw@example.ap-southeast.psdb.cloud:5432/postgres?sslmode=require"
}

run "hyperdrive_follows_the_design" {
  command = plan

  assert {
    condition     = cloudflare_hyperdrive_config.scos.caching.disabled == true
    error_message = "Hyperdrive caching must be disabled explicitly."
  }

  assert {
    condition     = cloudflare_hyperdrive_config.scos.origin_connection_limit == 5
    error_message = "origin_connection_limit must start at 5."
  }

  assert {
    condition = (
      cloudflare_hyperdrive_config.scos.origin.scheme == "postgres" &&
      cloudflare_hyperdrive_config.scos.origin.port == 5432 &&
      cloudflare_hyperdrive_config.scos.origin.database == "postgres" &&
      cloudflare_hyperdrive_config.scos.origin.user == "scos_runtime.example" &&
      cloudflare_hyperdrive_config.scos.origin.host == "example.ap-southeast.psdb.cloud"
    )
    error_message = "The origin must be the PlanetScale branch host as the runtime role, on 5432."
  }

  assert {
    condition     = cloudflare_hyperdrive_config.scos.name == "scos-prod"
    error_message = "The configuration is named after the environment."
  }
}

run "rejects_a_connection_limit_below_the_minimum" {
  command = plan

  variables {
    origin_connection_limit = 4
  }

  expect_failures = [var.origin_connection_limit]
}

run "rejects_a_host_with_a_scheme_or_credentials" {
  command = plan

  variables {
    planetscale_host = "postgres://user:pw@example.psdb.cloud"
  }

  expect_failures = [var.planetscale_host]
}

# --- Role credentials kept in the state (credentials.tf) -------------------

run "a_first_run_without_credentials_fails_the_plan" {
  command = plan

  variables {
    planetscale_runtime_password = ""
    migration_database_url       = ""
  }

  expect_failures = [cloudflare_hyperdrive_config.scos]
}

run "rejects_a_migration_url_without_tls" {
  command = plan

  variables {
    planetscale_runtime_password = "not-a-real-password"
    migration_database_url       = "postgresql://m:pw@example.ap-southeast.psdb.cloud:5432/postgres"
  }

  expect_failures = [var.migration_database_url]
}

run "the_first_credentials_are_stored" {
  variables {
    planetscale_runtime_password = "first-password"
    migration_database_url       = "postgresql://m:first@example.ap-southeast.psdb.cloud:5432/appdb?sslmode=require"
  }

  assert {
    condition     = nonsensitive(cloudflare_hyperdrive_config.scos.origin.password == "first-password")
    error_message = "Hyperdrive must use the supplied runtime password."
  }

  assert {
    condition     = cloudflare_hyperdrive_config.scos.origin.database == "appdb"
    error_message = "The origin database comes from the stored migration URL."
  }

  assert {
    condition     = nonsensitive(output.migration_database_url == "postgresql://m:first@example.ap-southeast.psdb.cloud:5432/appdb?sslmode=require")
    error_message = "The migration URL output must be the stored value."
  }
}

run "a_later_run_without_credentials_keeps_the_stored_ones" {
  variables {
    planetscale_runtime_password = ""
    migration_database_url       = ""
  }

  assert {
    condition     = nonsensitive(cloudflare_hyperdrive_config.scos.origin.password == "first-password")
    error_message = "An empty variable must keep the stored runtime password."
  }

  assert {
    condition     = nonsensitive(output.migration_database_url == "postgresql://m:first@example.ap-southeast.psdb.cloud:5432/appdb?sslmode=require")
    error_message = "An empty variable must keep the stored migration URL."
  }
}

run "a_new_value_without_replace_is_ignored" {
  variables {
    planetscale_runtime_password = "second-password"
    migration_database_url       = ""
  }

  assert {
    condition     = nonsensitive(cloudflare_hyperdrive_config.scos.origin.password == "first-password")
    error_message = "Only a replace may change the stored runtime password."
  }
}

run "rotation_replaces_the_stored_value" {
  variables {
    planetscale_runtime_password = "second-password"
    migration_database_url       = ""
  }

  plan_options {
    replace = [terraform_data.planetscale_runtime_password]
  }

  assert {
    condition     = nonsensitive(cloudflare_hyperdrive_config.scos.origin.password == "second-password")
    error_message = "A replace with a new value must update Hyperdrive's origin password."
  }

  assert {
    condition     = nonsensitive(output.migration_database_url == "postgresql://m:first@example.ap-southeast.psdb.cloud:5432/appdb?sslmode=require")
    error_message = "Rotating one role must keep the other role's credential."
  }
}

run "a_replace_without_a_value_fails_the_plan" {
  command = plan

  variables {
    planetscale_runtime_password = ""
    migration_database_url       = ""
  }

  plan_options {
    replace = [terraform_data.planetscale_runtime_password]
  }

  expect_failures = [cloudflare_hyperdrive_config.scos]
}
