terraform {
  required_version = ">= 1.14.7"

  required_providers {
    railway = {
      source  = "terraform-community-providers/railway"
      version = "0.6.1"
    }
  }
}
