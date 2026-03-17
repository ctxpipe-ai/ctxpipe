terraform {
  backend "s3" {
    # Cloudflare R2 (S3-compatible) remote state.
    #
    # Values are intentionally placeholders; set these via:
    # - `-backend-config=...` flags, or
    # - a local `backend.auto.tfvars` (NOT committed), or
    # - Terraform Cloud-style workspace variables if you wrap this elsewhere.
    bucket = "ctxpipe-terraform"
    key    = "terraform.tfstate"
    region = "auto"

    endpoints = {
      s3 = "https://a16260c38ab94c9e4d9eab98d0c7aca2.r2.cloudflarestorage.com"
    }

    use_path_style                = true
    skip_credentials_validation   = true
    skip_metadata_api_check       = true
    skip_region_validation        = true
    skip_requesting_account_id    = true
    skip_s3_checksum              = true
  }
}

