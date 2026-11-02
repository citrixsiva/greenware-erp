# =============================================================================
# Provider configuration.
#
# The token is NEVER committed. Supply it from the environment:
#     export DIGITALOCEAN_TOKEN="dop_v1_..."
# The provider reads DIGITALOCEAN_TOKEN (or DIGITALOCEAN_ACCESS_TOKEN) on its
# own, so var.do_token stays null in normal use and exists only for CI systems
# that can inject TF_VAR_do_token but not arbitrary environment variables.
# =============================================================================

provider "digitalocean" {
  token = var.do_token
}
