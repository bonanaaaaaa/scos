# The provider reads its API token from CLOUDFLARE_API_TOKEN, the prod
# environment secret of the same name. By the user's decision one token serves
# Terraform, Wrangler and the billing signature (docs/deployment-pipeline.md).
# The only credentials in this configuration are the PlanetScale role
# credentials (credentials.tf); Hyperdrive needs the runtime password.
provider "cloudflare" {}

# One Hyperdrive configuration, bound by the Worker as HYPERDRIVE and used by
# every ordering path (docs/cloudflare-deployment-design.md).
resource "cloudflare_hyperdrive_config" "scos" {
  account_id = var.cloudflare_account_id
  name       = "scos-${var.environment}"

  # PlanetScale Postgres branch (main), reached as the least-privilege runtime
  # role. Host and user are non-secret inputs read from PlanetScale on every
  # deploy; the password is the one stored in the state (credentials.tf).
  # TLS: Hyperdrive's default sslmode is `require` with WebPKI validation;
  # verify-full (an uploaded CA plus `mtls`) is optional hardening, not set.
  origin = {
    scheme   = "postgres"
    host     = var.planetscale_host
    port     = var.origin_port
    database = local.origin_database
    user     = var.hyperdrive_origin_user
    password = local.runtime_password
  }

  # Caching is disabled explicitly, never left to the default (which caches
  # reads for 60 s): Hyperdrive does not invalidate cached reads on write, and
  # stock, estimate and submission-key reads must never be stale.
  caching = {
    disabled = true
  }

  origin_connection_limit = var.origin_connection_limit

  lifecycle {
    # Fails the plan, before anything is applied, when the state holds no
    # role credential. Fresh ones are stored by a targeted apply right after
    # the PlanetScale step (deploy.yml), so a full plan never needs them.
    precondition {
      condition     = nonsensitive(local.runtime_password != "")
      error_message = "No runtime role password is stored in the Terraform state. Restore a state backup that holds it, or rotate the runtime role (Deploy Prod, rotate_credentials: runtime). See docs/deployment-pipeline.md#role-credentials-in-the-state."
    }

    # The migration URL is checked here too, not on its output, so that a
    # targeted store of one credential never trips over the other.
    precondition {
      condition     = nonsensitive(local.migration_database_url != "")
      error_message = "No migration role URL is stored in the Terraform state. Restore a state backup that holds it, or rotate the migration role (Deploy Prod, rotate_credentials: migration). See docs/deployment-pipeline.md#role-credentials-in-the-state."
    }
  }
}
