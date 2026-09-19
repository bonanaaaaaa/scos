# Terraform for the Cloudflare side of the SCOS deployment (#15): the
# Hyperdrive configuration the Worker binds as HYPERDRIVE. The PlanetScale
# database and its roles belong to infra/planetscale/; the Worker belongs to
# Wrangler (apps/api/wrangler.jsonc). See docs/deployment-pipeline.md.

terraform {
  # use_lockfile on the s3 backend needs Terraform 1.10 or later. CI and the
  # deploy workflow pin the exact version (TERRAFORM_VERSION in
  # .github/workflows/infra-check.yml and deploy.yml).
  required_version = ">= 1.11.0, < 2.0.0"

  required_providers {
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "5.25.0"
    }
  }

  # State lives in the private R2 bucket. This block holds only the fixed
  # settings R2 needs. The per-environment settings (bucket, key, region,
  # endpoint, workspace prefix) come from the GitHub environment's TF_STATE_*
  # variables through scripts/backend-init.sh, and the R2 key pair only from
  # AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY in the environment.
  backend "s3" {
    use_path_style              = true
    use_lockfile                = true
    skip_credentials_validation = true
    skip_region_validation      = true
    skip_requesting_account_id  = true
    skip_metadata_api_check     = true
    skip_s3_checksum            = true
  }
}
