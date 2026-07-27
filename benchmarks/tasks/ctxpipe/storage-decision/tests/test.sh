#!/bin/bash
set -euo pipefail

uvx --from 'harbor-rewardkit==0.1.*' rewardkit /tests
