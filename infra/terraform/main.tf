# =============================================================================
# Greenware ERP — DigitalOcean droplet + Managed Postgres 16
#
# Everything here is NEW and filed under its own project. Nothing in this file
# reads, imports, modifies or references an existing droplet, database or VPC.
# There is no `import` block and no data source pointing at production: the only
# data sources are SSH key lookups, which read account metadata and change
# nothing.
#
#   cd infra/terraform
#   export DIGITALOCEAN_TOKEN=dop_v1_...
#   terraform init
#   terraform plan -out tf.plan      # READ THE PLAN before applying
#   terraform apply tf.plan
# =============================================================================

locals {
  name = "${var.project_name}-${var.environment}"

  base_tags = concat(
    [
      var.project_name,
      "env:${var.environment}",
      "managed-by:terraform",
    ],
    var.extra_tags,
  )
}

# Caddy cannot get a certificate without a contact address, and a domain set
# with no address silently falls back to plain HTTP. Fail the plan instead.
check "tls_configuration_is_complete" {
  assert {
    condition     = var.app_domain == "" || var.acme_email != ""
    error_message = "app_domain is set but acme_email is empty — Let's Encrypt needs a contact address, so TLS would silently not be configured."
  }
}

# -----------------------------------------------------------------------------
# Tags. Created explicitly so they are owned by this stack rather than appearing
# as side effects, and so `terraform destroy` removes them.
# -----------------------------------------------------------------------------
resource "digitalocean_tag" "all" {
  for_each = toset(local.base_tags)
  name     = each.value
}

# -----------------------------------------------------------------------------
# SSH keys — looked up, never created. If a name here does not exist in the
# account, the plan fails rather than building a droplet nobody can log in to.
# -----------------------------------------------------------------------------
data "digitalocean_ssh_key" "operators" {
  for_each = toset(var.ssh_key_names)
  name     = each.value
}

# -----------------------------------------------------------------------------
# A dedicated VPC. This is what makes the database's trusted-source rule mean
# something: droplet and cluster talk over private addresses that never leave
# DigitalOcean's network, and the cluster needs no public route at all.
# -----------------------------------------------------------------------------
resource "digitalocean_vpc" "erp" {
  name     = "${local.name}-vpc"
  region   = var.region
  ip_range = "10.118.0.0/20"

  description = "Greenware ERP — private network for the ERP droplet and its Postgres cluster. Separate from any existing Greenware VPC."
}

# -----------------------------------------------------------------------------
# Application droplet. Docker + Caddy are installed by cloud-init; the
# application itself is deployed with docker-compose.yml from the repo.
# -----------------------------------------------------------------------------
resource "digitalocean_droplet" "app" {
  name     = "${local.name}-app"
  image    = var.droplet_image
  size     = var.droplet_size
  region   = var.region
  vpc_uuid = digitalocean_vpc.erp.id

  ssh_keys = [for k in data.digitalocean_ssh_key.operators : k.fingerprint]

  # Free, and the alert policies below have nothing to read without it.
  monitoring = true
  ipv6       = true

  # Droplet backups cover the OS, the Docker state and — importantly — the
  # generated-document store on local disk (DOCUMENT_STORE_DIR), which is the
  # one piece of application data that is NOT in Postgres. The default plan is
  # weekly; daily is the point of this block.
  backups = true
  backup_policy {
    plan    = "daily"
    hour    = var.droplet_backup_hour
    monthly = false
  }

  user_data = templatefile("${path.module}/cloud-init.yaml.tftpl", {
    app_domain  = var.app_domain
    acme_email  = var.acme_email
    repo_dir    = "/opt/greenware-erp"
    web_port    = 8081
  })

  tags = [for t in digitalocean_tag.all : t.id]

  graceful_shutdown = true

  lifecycle {
    # Changing user_data rebuilds the droplet. cloud-init only installs the
    # host prerequisites, so editing it must not quietly destroy a running
    # system — change the host by hand, or taint deliberately.
    ignore_changes = [user_data]
  }
}

# -----------------------------------------------------------------------------
# Reserved IP. DNS points here, so the droplet can be rebuilt or replaced
# without touching the DNS zone or re-issuing certificates.
# -----------------------------------------------------------------------------
resource "digitalocean_reserved_ip" "app" {
  region = var.region
}

resource "digitalocean_reserved_ip_assignment" "app" {
  ip_address = digitalocean_reserved_ip.app.ip_address
  droplet_id = digitalocean_droplet.app.id
}

# -----------------------------------------------------------------------------
# Cloud firewall — 80, 443 and 22 inbound. Nothing else.
#
# This is the real perimeter: ports 8080 and 8081 are published by
# docker-compose.yml and are NOT in this list, so the API and the nginx edge are
# unreachable from the internet. Only Caddy on 80/443 is.
# -----------------------------------------------------------------------------
resource "digitalocean_firewall" "app" {
  name        = "${local.name}-fw"
  droplet_ids = [digitalocean_droplet.app.id]

  inbound_rule {
    protocol         = "tcp"
    port_range       = "80"
    source_addresses = ["0.0.0.0/0", "::/0"]
  }

  inbound_rule {
    protocol         = "tcp"
    port_range       = "443"
    source_addresses = ["0.0.0.0/0", "::/0"]
  }

  inbound_rule {
    protocol         = "tcp"
    port_range       = "22"
    source_addresses = var.ssh_allowed_cidrs
  }

  # Outbound is open: the host needs apt, Docker Hub, the npm registry during
  # image builds, and Let's Encrypt. Narrow it only with a proxy in place.
  outbound_rule {
    protocol              = "tcp"
    port_range            = "1-65535"
    destination_addresses = ["0.0.0.0/0", "::/0"]
  }

  outbound_rule {
    protocol              = "udp"
    port_range            = "1-65535"
    destination_addresses = ["0.0.0.0/0", "::/0"]
  }

  outbound_rule {
    protocol              = "icmp"
    destination_addresses = ["0.0.0.0/0", "::/0"]
  }
}

# -----------------------------------------------------------------------------
# Managed PostgreSQL 16.
#
# Backups: DigitalOcean takes a daily full backup plus continuous write-ahead
# log shipping on every managed cluster. It is ALWAYS ON and there is no
# Terraform attribute to configure it — retention and point-in-time window are
# set by the service, not here. What that actually buys you, and where it falls
# short of a 5-minute RPO, is written out in docs/DEPLOYMENT.md. Do not read the
# absence of a backup block here as "backups are off".
# -----------------------------------------------------------------------------
resource "digitalocean_database_cluster" "pg" {
  name       = "${local.name}-pg"
  engine     = "pg"
  version    = "16"
  size       = var.db_size
  region     = var.region
  node_count = var.db_node_count

  # No public endpoint is needed: the droplet reaches it over the VPC.
  private_network_uuid = digitalocean_vpc.erp.id

  maintenance_window {
    day  = var.db_maintenance_day
    hour = var.db_maintenance_hour
  }

  tags = [for t in digitalocean_tag.all : t.id]

  lifecycle {
    # A cluster holding the commercial history this system is built to keep
    # (7-year audit retention, indefinite price history) must not be removable
    # by an accidental `terraform destroy`. Remove this block deliberately, in
    # its own commit, if the cluster is ever genuinely meant to go.
    prevent_destroy = true
  }
}

resource "digitalocean_database_db" "erp" {
  cluster_id = digitalocean_database_cluster.pg.id
  name       = var.db_name
}

# -----------------------------------------------------------------------------
# Trusted sources — the droplet, and only the droplet.
#
# A managed cluster with NO firewall rules accepts connections from anywhere on
# the internet with valid credentials. This resource is what closes it. There is
# deliberately no ip_addr rule for an office or a laptop: to reach the database
# from outside, SSH to the droplet and go through it.
# -----------------------------------------------------------------------------
resource "digitalocean_database_firewall" "pg" {
  cluster_id = digitalocean_database_cluster.pg.id

  rule {
    type  = "droplet"
    value = digitalocean_droplet.app.id
  }
}

# -----------------------------------------------------------------------------
# PgBouncer in transaction mode.
#
# Safe here because every write goes through tx() in api/src/core/db.ts, which
# sets its app.* settings with set_config(..., true) — transaction-scoped, so no
# state survives a pooled connection being handed to another request. Migrations
# must still use the direct cluster URI, not this pool.
# -----------------------------------------------------------------------------
resource "digitalocean_database_connection_pool" "api" {
  count = var.enable_connection_pool ? 1 : 0

  cluster_id = digitalocean_database_cluster.pg.id
  name       = "api-pool"
  mode       = "transaction"
  size       = 18
  db_name    = digitalocean_database_db.erp.name
  user       = "doadmin"
}

# -----------------------------------------------------------------------------
# The project. Named so that nobody confuses these resources with existing
# Greenware production.
# -----------------------------------------------------------------------------
resource "digitalocean_project" "erp" {
  name        = var.project_name
  description = "Greenware enquiry-to-cash ERP/CRM. Created by infra/terraform in the greenware-erp repository. Does not include any pre-existing Greenware production resource."
  purpose     = "Web Application"
  environment = var.environment == "prod" ? "Production" : "Staging"

  resources = [
    digitalocean_droplet.app.urn,
    digitalocean_database_cluster.pg.urn,
    digitalocean_reserved_ip.app.urn,
  ]
}

# -----------------------------------------------------------------------------
# Alerts. Email only — no webhook or channel secrets in this repo.
#
# A monitor alert must have at least one destination, so these exist only when
# var.alert_emails is non-empty rather than being created disabled.
# -----------------------------------------------------------------------------
resource "digitalocean_monitor_alert" "droplet_disk" {
  count = length(var.alert_emails) > 0 ? 1 : 0

  alerts {
    email = var.alert_emails
  }
  window      = "5m"
  type        = "v1/insights/droplet/disk_utilization_percent"
  compare     = "GreaterThan"
  value       = 80
  enabled     = true
  entities    = [tostring(digitalocean_droplet.app.id)]
  description = "Greenware ERP droplet disk above 80% — the document store and Docker images share this disk."
}

resource "digitalocean_monitor_alert" "droplet_memory" {
  count = length(var.alert_emails) > 0 ? 1 : 0

  alerts {
    email = var.alert_emails
  }
  window      = "5m"
  type        = "v1/insights/droplet/memory_utilization_percent"
  compare     = "GreaterThan"
  value       = 85
  enabled     = true
  entities    = [tostring(digitalocean_droplet.app.id)]
  description = "Greenware ERP droplet memory above 85%."
}
