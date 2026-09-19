# Only what the pipeline needs. The Hyperdrive ID is not a credential, but it
# is marked sensitive so it never appears in plan or apply output; the deploy
# workflow reads it with `terraform output -raw` and masks it.
output "hyperdrive_id" {
  description = "ID of the Hyperdrive configuration, injected into the Worker's HYPERDRIVE binding before wrangler deploy."
  value       = cloudflare_hyperdrive_config.scos.id
  sensitive   = true
}

# The migration role's URL, read by the deploy's migration step with
# `terraform output -raw` and masked before use. Never printed.
output "migration_database_url" {
  description = "Connection URL of the migration role, direct to the PlanetScale branch (sslmode=require)."
  value       = local.migration_database_url
  sensitive   = true
}
