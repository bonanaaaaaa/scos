# The provider reads its API token from CLOUDFLARE_API_TOKEN, which the deploy
# workflow maps from the prod environment secret CLOUDFLARE_TERRAFORM_API_TOKEN
# (Hyperdrive edit only). No credential is ever a Terraform variable here
# except the origin password, which Hyperdrive itself needs.
provider "cloudflare" {}

# One Hyperdrive configuration, bound by the Worker as HYPERDRIVE and used by
# every ordering path (docs/cloudflare-deployment-design.md).
resource "cloudflare_hyperdrive_config" "scos" {
  account_id = var.cloudflare_account_id
  name       = "scos-${var.environment}"

  # PlanetScale Postgres branch (main), reached as the least-privilege runtime
  # role. All non-secret inputs; only the password is sensitive.
  # TLS: Hyperdrive's default sslmode is `require` with WebPKI validation;
  # verify-full (an uploaded CA plus `mtls`) is optional hardening, not set.
  origin = {
    scheme   = "postgres"
    host     = var.planetscale_host
    port     = var.origin_port
    database = var.hyperdrive_origin_database
    user     = var.hyperdrive_origin_user
    password = var.hyperdrive_origin_password
  }

  # Caching is disabled explicitly, never left to the default (which caches
  # reads for 60 s): Hyperdrive does not invalidate cached reads on write, and
  # stock, estimate and submission-key reads must never be stale.
  caching = {
    disabled = true
  }

  origin_connection_limit = var.origin_connection_limit
}
