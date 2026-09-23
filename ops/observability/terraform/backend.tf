terraform {
  backend "s3" {
    # Cloudflare R2 (S3-compatible) remote state. Separate key from product infra/.
    #
    # Credentials via:
    # - `-backend-config=access_key=... -backend-config=secret_key=...`, or
    # - AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY
    bucket = "ctxpipe-terraform"
    key    = "observability/terraform.tfstate"
    region = "auto"

    endpoints = {
      s3 = "https://a16260c38ab94c9e4d9eab98d0c7aca2.r2.cloudflarestorage.com"
    }

    use_path_style              = true
    skip_credentials_validation = true
    skip_metadata_api_check     = true
    skip_region_validation      = true
    skip_requesting_account_id  = true
    skip_s3_checksum            = true
  }
}
