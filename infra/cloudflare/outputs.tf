# Only what the pipeline needs. The Hyperdrive ID is not a credential, but it
# is marked sensitive so it never appears in plan or apply output; the deploy
# workflow reads it with `terraform output -raw` and masks it.
output "hyperdrive_id" {
  description = "ID of the Hyperdrive configuration, injected into the Worker's HYPERDRIVE binding before wrangler deploy."
  value       = cloudflare_hyperdrive_config.scos.id
  sensitive   = true
}
