# =============================================================================
# Provider and version constraints.
# =============================================================================

terraform {
  required_version = ">= 1.6.0"

  required_providers {
    digitalocean = {
      source = "digitalocean/digitalocean"
      # 2.43 is the floor because digitalocean_droplet.backup_policy (used to
      # pin droplet backups to a DAILY plan rather than DigitalOcean's default
      # weekly one) was added in 2.41, and 2.43 is the first release where it is
      # stable for existing droplets.
      version = "~> 2.43"
    }
  }

  # State holds the database connection URI, including the doadmin password, in
  # cleartext. Keep it off laptops and out of git.
  #
  # Recommended: a DigitalOcean Spaces bucket in the SAME region, created by
  # hand (not by this stack, which would need the bucket to exist to store its
  # own state). Uncomment and fill in, then `terraform init -migrate-state`.
  #
  # backend "s3" {
  #   endpoints                   = { s3 = "https://fra1.digitaloceanspaces.com" }
  #   region                      = "us-east-1" # ignored by Spaces; required by the S3 backend
  #   bucket                      = "greenware-erp-tfstate"
  #   key                         = "greenware-erp/terraform.tfstate"
  #   skip_credentials_validation = true
  #   skip_metadata_api_check     = true
  #   skip_region_validation      = true
  #   skip_requesting_account_id  = true
  #   skip_s3_checksum            = true
  #   use_path_style              = true
  #   encrypt                     = true
  # }
  #
  # Spaces access keys go in AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY, never in
  # this file.
}
