# =============================================================================
# Inputs. No secrets have defaults; nothing secret belongs in a committed file.
# Copy terraform.tfvars.example to terraform.tfvars and edit.
# =============================================================================

variable "do_token" {
  description = <<-EOT
    DigitalOcean personal access token with read+write scope. Leave null and
    export DIGITALOCEAN_TOKEN instead — that is the normal path and keeps the
    token out of terraform.tfvars and out of the plan output.
  EOT
  type        = string
  default     = null
  sensitive   = true
}

variable "project_name" {
  description = <<-EOT
    DigitalOcean project that every resource here is filed under. A separate,
    clearly-named project is the whole point: nothing in this stack touches
    existing Greenware production droplets or databases.
  EOT
  type        = string
  default     = "greenware-erp"
}

variable "environment" {
  description = "Environment suffix used in resource names and tags."
  type        = string
  default     = "prod"

  validation {
    condition     = can(regex("^[a-z0-9-]{2,16}$", var.environment))
    error_message = "environment must be 2-16 characters of lowercase letters, digits or hyphens."
  }
}

variable "region" {
  description = <<-EOT
    DigitalOcean region slug.

    fra1 (Frankfurt) is the default. DigitalOcean has NO UAE or wider Middle
    East region, so no slug here satisfies a "UAE data stays in the UAE"
    requirement — see the data-residency section of docs/DEPLOYMENT.md before
    accepting this default.

    blr1 (Bangalore) is measurably closer to Dubai in network terms and would
    also sit next to the Trichy team, at the cost of moving UAE commercial data
    under Indian jurisdiction. Change this in one place if you choose it; every
    resource below follows it, including the Spaces endpoint in versions.tf,
    which you must change by hand.
  EOT
  type        = string
  default     = "fra1"
}

variable "droplet_size" {
  description = <<-EOT
    Droplet slug. s-2vcpu-4gb is the floor for running the API, the nginx edge
    and Caddy together with headroom for document generation, which renders
    quotation and RFQ HTML in-process.
  EOT
  type        = string
  default     = "s-2vcpu-4gb"
}

variable "droplet_image" {
  description = "Droplet base image. Pin a dated snapshot if reproducibility matters more than patches."
  type        = string
  default     = "ubuntu-24-04-x64"
}

variable "ssh_key_names" {
  description = <<-EOT
    Names of SSH keys ALREADY present in the DigitalOcean account, exactly as
    they appear under Settings > Security. These are looked up, not created, so
    this stack cannot add an unknown key to the droplet. At least one is
    required: without it the droplet is only reachable through the recovery
    console.
  EOT
  type        = list(string)

  validation {
    condition     = length(var.ssh_key_names) > 0
    error_message = "Name at least one existing DigitalOcean SSH key."
  }
}

variable "ssh_allowed_cidrs" {
  description = <<-EOT
    Source ranges allowed to reach port 22. Use the office/VPN egress ranges.
    0.0.0.0/0 is accepted but means the SSH port is open to the internet and
    only the key protects it.
  EOT
  type        = list(string)

  validation {
    condition     = length(var.ssh_allowed_cidrs) > 0
    error_message = "Give at least one CIDR for SSH, or the droplet is unreachable over the network."
  }
}

variable "db_size" {
  description = <<-EOT
    Managed Postgres node slug. db-s-1vcpu-2gb is the smallest size worth using:
    api/src/core/db.ts opens a pool of up to 20 connections, and the 1 GB node's
    connection ceiling leaves almost no margin above that.
  EOT
  type        = string
  default     = "db-s-1vcpu-2gb"
}

variable "db_node_count" {
  description = <<-EOT
    Managed Postgres nodes. 1 = primary only. 2 or 3 adds standby nodes and is
    what actually shortens recovery time after a node failure; see the RTO/RPO
    section of docs/DEPLOYMENT.md, where the honest position is set out.
  EOT
  type        = number
  default     = 1

  validation {
    condition     = var.db_node_count >= 1 && var.db_node_count <= 3
    error_message = "db_node_count must be 1, 2 or 3."
  }
}

variable "db_name" {
  description = "Logical database created inside the cluster."
  type        = string
  default     = "greenware"
}

variable "db_maintenance_day" {
  description = "Weekday for the managed-Postgres maintenance window."
  type        = string
  default     = "sunday"
}

variable "db_maintenance_hour" {
  description = <<-EOT
    Maintenance window start, UTC, HH:MM:SS. 22:00 UTC is 02:00 in Dubai
    (UTC+4) and 03:30 in Trichy (UTC+5:30) — outside working hours for both
    offices, which is the only thing that matters here.
  EOT
  type        = string
  default     = "22:00:00"
}

variable "enable_connection_pool" {
  description = <<-EOT
    Create a PgBouncer connection pool in front of the cluster.

    Transaction mode is safe for this application: every mutating path goes
    through tx() in api/src/core/db.ts, which sets app.user_id / app.employee_id
    / app.sbu_id / app.scope with set_config(..., true) — transaction-scoped, so
    nothing leaks between pooled sessions. Do NOT switch the pool to session
    mode and do not use it for the migration job.
  EOT
  type        = bool
  default     = true
}

variable "droplet_backup_hour" {
  description = <<-EOT
    UTC hour for the daily droplet backup. 20:00 UTC is midnight in Dubai.
    Note what droplet backups are for: the OS, Docker and the generated-document
    store on local disk. Postgres is backed up by the managed service, not here.
  EOT
  type        = number
  default     = 20

  validation {
    condition     = var.droplet_backup_hour >= 0 && var.droplet_backup_hour <= 23
    error_message = "droplet_backup_hour must be 0-23."
  }
}

variable "app_domain" {
  description = <<-EOT
    Hostname the ERP is served on, e.g. erp.greenware.ae. When set, cloud-init
    configures Caddy to obtain and renew a Let's Encrypt certificate for it, and
    the DNS A record must already point at the reserved IP this stack outputs.
    Leave empty to serve plain HTTP on port 80 — acceptable only for a first
    smoke test, never for real data.
  EOT
  type        = string
  default     = ""
}

variable "acme_email" {
  description = "Contact address for Let's Encrypt expiry notices. Required when app_domain is set."
  type        = string
  default     = ""

  validation {
    condition     = var.acme_email == "" || can(regex("^[^@[:space:]]+@[^@[:space:]]+\\.[^@[:space:]]+$", var.acme_email))
    error_message = "acme_email must be a valid email address, or empty."
  }
}

variable "alert_emails" {
  description = <<-EOT
    Addresses that receive droplet disk/memory alerts. Empty means no alert
    policies are created at all — a monitor alert must have a destination, so
    there is no "created but silent" state to be misled by.
  EOT
  type        = list(string)
  default     = []
}

variable "extra_tags" {
  description = "Extra DigitalOcean tags applied to the droplet and database cluster."
  type        = list(string)
  default     = []
}
