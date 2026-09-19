# A resource-free root used only by scripts/prove-state-lock.sh to prove that
# the s3 backend's lock file (use_lockfile) rejects a second concurrent run.
# It has no provider and no resources, so it needs no Cloudflare credential
# and its state never holds anything. It runs against a throwaway key, never
# against an environment's real state key.
#
# The backend block matches ../versions.tf exactly: the proof is only
# meaningful if the settings are the ones the real state uses.

terraform {
  required_version = ">= 1.11.0, < 2.0.0"

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

# Something to plan, so that `terraform apply` stops at its approval prompt
# while holding the lock. The holder always answers "no": nothing is ever
# created and the state is never written. terraform_data is built in; no
# provider is downloaded.
resource "terraform_data" "lock_proof" {}
