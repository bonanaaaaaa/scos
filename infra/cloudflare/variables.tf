variable "cloudflare_account_id" {
  description = "Cloudflare account that owns the Hyperdrive configuration (GitHub environment variable CLOUDFLARE_ACCOUNT_ID)."
  type        = string

  validation {
    condition     = can(regex("^[0-9a-f]{32}$", var.cloudflare_account_id))
    error_message = "cloudflare_account_id must be a 32-character lowercase hex account ID."
  }
}

variable "environment" {
  description = "Deployment environment name; part of the Hyperdrive configuration name."
  type        = string

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{0,15}$", var.environment))
    error_message = "environment must be lowercase letters, digits or hyphens, starting with a letter."
  }
}

variable "planetscale_host" {
  description = "Host of the PlanetScale Postgres branch (main), for example <id>.<region>.psdb.cloud. Not secret."
  type        = string

  validation {
    condition     = can(regex("^[A-Za-z0-9.-]+$", var.planetscale_host))
    error_message = "planetscale_host must be a bare hostname: no scheme, port, path or credentials."
  }
}

variable "hyperdrive_origin_database" {
  description = "PostgreSQL database name on the branch, as PlanetScale reports it (GitHub environment variable HYPERDRIVE_ORIGIN_DATABASE, usually postgres). Not the PlanetScale database resource name (PLANETSCALE_DATABASE)."
  type        = string
  default     = "postgres"
}

variable "origin_port" {
  description = "Origin port: PlanetScale Postgres accepts direct connections on 5432."
  type        = number
  default     = 5432
}

variable "hyperdrive_origin_user" {
  description = "Connection username of the runtime role, exactly as PlanetScale reports it (it may carry a branch suffix; infra/planetscale/bootstrap.sh prints it). GitHub environment variable HYPERDRIVE_ORIGIN_USER. Never the default administrative role."
  type        = string

  validation {
    condition     = can(regex("^[A-Za-z0-9._-]+$", var.hyperdrive_origin_user))
    error_message = "hyperdrive_origin_user must be a bare username."
  }
}

variable "hyperdrive_origin_password" {
  description = "The runtime role's password (GitHub environment secret HYPERDRIVE_ORIGIN_PASSWORD). It is stored in the state, which is why the state is a secret."
  type        = string
  sensitive   = true
  nullable    = false

  validation {
    condition     = length(var.hyperdrive_origin_password) > 0
    error_message = "hyperdrive_origin_password must not be empty."
  }
}

variable "origin_connection_limit" {
  description = "Soft maximum of origin connections (docs/cloudflare-deployment-design.md, connection budget). Starts at the minimum, 5; #33 revisits it."
  type        = number
  default     = 5

  validation {
    condition     = var.origin_connection_limit >= 5 && var.origin_connection_limit <= 20
    error_message = "origin_connection_limit must be between 5 (the minimum) and 20 (the Workers Free soft maximum); check the connection budget rule before raising it."
  }
}
