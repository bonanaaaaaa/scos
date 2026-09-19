# Offline checks of the Hyperdrive configuration: `terraform test` with a
# mocked provider, so no credential or account is needed (infra-check.yml).

mock_provider "cloudflare" {}

variables {
  cloudflare_account_id      = "0123456789abcdef0123456789abcdef"
  environment                = "prod"
  planetscale_host           = "example.ap-southeast.psdb.cloud"
  hyperdrive_origin_user     = "scos_runtime.example"
  hyperdrive_origin_password = "not-a-real-password"
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

run "rejects_an_empty_password" {
  command = plan

  variables {
    hyperdrive_origin_password = ""
  }

  expect_failures = [var.hyperdrive_origin_password]
}
