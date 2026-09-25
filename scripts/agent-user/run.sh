#!/bin/bash
set -euo pipefail
root=$(cd "$(dirname "$0")/../.." && pwd)
docker run --rm --cap-add=NET_ADMIN -v "$root:/repo:ro" oven/bun:1.4 bash -c 'bash /repo/scripts/agent-user/setup.sh && cd /repo/scripts/agent-user && bun check.ts && bun vault-check.ts' 2>&1 | grep -v '^{"level'
