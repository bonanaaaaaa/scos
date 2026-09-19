# The deploy stores a fresh credential right after the PlanetScale step with a
# targeted apply of only its terraform_data resource, before anything else can
# fail (deploy.yml, "Store fresh role credentials in the state"). These runs
# start from an empty state.

mock_provider "cloudflare" {}

variables {
  cloudflare_account_id  = "0123456789abcdef0123456789abcdef"
  environment            = "prod"
  planetscale_host       = "example.ap-southeast.psdb.cloud"
  hyperdrive_origin_user = "scos_runtime.example"
}

run "store_only_the_runtime_password" {
  variables {
    planetscale_runtime_password = "runtime-first"
  }

  plan_options {
    target  = [terraform_data.planetscale_runtime_password]
    replace = [terraform_data.planetscale_runtime_password]
  }

  assert {
    condition     = nonsensitive(terraform_data.planetscale_runtime_password.input == "runtime-first")
    error_message = "The targeted apply must store the runtime password."
  }
}

run "a_full_plan_without_the_migration_url_fails" {
  command = plan

  expect_failures = [cloudflare_hyperdrive_config.scos]
}

run "store_only_the_migration_url" {
  variables {
    migration_database_url = "postgresql://m:first@example.ap-southeast.psdb.cloud:5432/postgres?sslmode=require"
  }

  plan_options {
    target  = [terraform_data.migration_database_url]
    replace = [terraform_data.migration_database_url]
  }
}

run "the_full_apply_then_needs_no_credential_input" {
  assert {
    condition     = nonsensitive(cloudflare_hyperdrive_config.scos.origin.password == "runtime-first")
    error_message = "Hyperdrive must use the stored runtime password."
  }

  assert {
    condition     = nonsensitive(output.migration_database_url == "postgresql://m:first@example.ap-southeast.psdb.cloud:5432/postgres?sslmode=require")
    error_message = "The migration URL output must be the stored value."
  }
}
