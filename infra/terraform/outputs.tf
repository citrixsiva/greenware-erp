# =============================================================================
# Outputs.
#
# Anything carrying a password is marked sensitive, so it is withheld from plan
# and apply output. Read one deliberately:
#     terraform output -raw database_url_direct
# It is still in cleartext in the state file — see the backend note in versions.tf.
# =============================================================================

output "droplet_public_ip" {
  description = "Droplet's own public IPv4. Prefer the reserved IP for DNS."
  value       = digitalocean_droplet.app.ipv4_address
}

output "reserved_ip" {
  description = "Point the application's DNS A record here, not at droplet_public_ip."
  value       = digitalocean_reserved_ip.app.ip_address
}

output "droplet_private_ip" {
  description = "VPC address. This is what the database's trusted-source rule admits."
  value       = digitalocean_droplet.app.ipv4_address_private
}

output "ssh_command" {
  description = "How to reach the host. Root login is disabled by cloud-init."
  value       = "ssh deploy@${digitalocean_reserved_ip.app.ip_address}"
}

output "database_host_private" {
  description = "Private hostname of the Postgres cluster — resolvable from inside the VPC only."
  value       = digitalocean_database_cluster.pg.private_host
}

output "database_port" {
  value       = digitalocean_database_cluster.pg.port
  description = "Managed Postgres listens on 25060, not 5432."
}

output "database_url_direct" {
  description = <<-EOT
    doadmin URI over the private network. Use this for MIGRATIONS and for
    anything that needs CREATE EXTENSION or CREATE ROLE — 001_core.sql needs
    both. Already contains ?sslmode=require.
  EOT
  value = "postgres://${digitalocean_database_cluster.pg.user}:${digitalocean_database_cluster.pg.password}@${digitalocean_database_cluster.pg.private_host}:${digitalocean_database_cluster.pg.port}/${digitalocean_database_db.erp.name}?sslmode=require"
  sensitive = true
}

output "database_url_pooled" {
  description = <<-EOT
    PgBouncer (transaction mode) URI for the API's DATABASE_URL. Null when
    enable_connection_pool is false. Never use this for migrations.
  EOT
  value = var.enable_connection_pool ? "postgres://${digitalocean_database_connection_pool.api[0].user}:${digitalocean_database_connection_pool.api[0].password}@${digitalocean_database_connection_pool.api[0].private_host}:${digitalocean_database_connection_pool.api[0].port}/${digitalocean_database_connection_pool.api[0].name}?sslmode=require" : null
  sensitive = true
}

output "project_id" {
  description = "The DigitalOcean project everything above is filed under."
  value       = digitalocean_project.erp.id
}

output "vpc_id" {
  value       = digitalocean_vpc.erp.id
  description = "Dedicated VPC — not shared with any pre-existing Greenware network."
}

output "region" {
  value       = var.region
  description = "Region every resource was created in."
}

output "next_steps" {
  description = "What to do once apply finishes."
  value       = <<-EOT
    1. Point DNS:  ${var.app_domain == "" ? "<your hostname>" : var.app_domain} A -> ${digitalocean_reserved_ip.app.ip_address}
    2. ssh deploy@${digitalocean_reserved_ip.app.ip_address}
    3. Follow /opt/greenware-erp/README-FIRST.md and docs/DEPLOYMENT.md.
    4. Apply migrations with the DIRECT url:  terraform output -raw database_url_direct
    5. Set the API's DATABASE_URL to ${var.enable_connection_pool ? "the POOLED url (terraform output -raw database_url_pooled)" : "the direct url"}.
    6. Confirm the database has no public ingress:
         doctl databases firewalls list ${digitalocean_database_cluster.pg.id}
       It must list exactly one droplet rule and nothing else.
  EOT
}
