#!/usr/bin/env bash
# Refuse a saved plan that would delete or replace a Railway service, custom
# domain, or variable collection, or change a service volume.
set -euo pipefail

plan_file="${1:-terraform.plan}"
if [[ ! -f "$plan_file" ]]; then
  echo "No Terraform plan file at $plan_file" >&2
  exit 1
fi

json="${RUNNER_TEMP:-/tmp}/observability-plan.json"
terraform show -json "$plan_file" > "$json"

bad="$(jq -r '
  def volume_changed:
    . as $ch
    | ($ch.before.volume // null) as $b
    | ($ch.after.volume // null) as $a
    | ($ch.after_unknown.volume // null) as $u
    | if ($b == null) and ($a == null) then false
      elif ($b == null) or ($a == null) then true
      else
        ($a
          | if ($u.id == true) then .id = $b.id else . end
          | if ($u.size == true) then .size = $b.size else . end
        ) as $an
        | ($b != $an)
      end;
  def has_delete:
    any(.change.actions[]?; . == "delete");
  def is_service:
    .type == "railway_service" or (.address | startswith("railway_service."));
  def is_custom_domain:
    .type == "railway_custom_domain" or (.address | startswith("railway_custom_domain."));
  def is_variable_collection:
    .type == "railway_variable_collection" or (.address | startswith("railway_variable_collection."));
  [
    .resource_changes[]?
    | . as $r
    | select(
        ($r | is_service and (
          ($r | has_delete)
          or (
            any($r.change.actions[]?; . == "update")
            and ($r.change | volume_changed)
          )
        ))
        or (($r | is_custom_domain or is_variable_collection) and ($r | has_delete))
      )
    | "\($r.address) actions=\($r.change.actions | join(","))"
      + (if (($r | is_service) and ($r.change | volume_changed)) then " volume_changed" else "" end)
  ] | .[]
' "$json")"

if [[ -n "$bad" ]]; then
  echo "Refusing this plan: it would delete or replace a railway_service, railway_custom_domain, or railway_variable_collection, or change a service volume."
  echo "ClickHouse and Mongo volumes, public hostnames, and managed variables must not be destroyed by automation."
  echo "$bad"
  exit 1
fi

echo "No railway_service, custom domain, or variable collection delete/replace, and no service volume change."
