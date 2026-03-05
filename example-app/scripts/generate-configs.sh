#!/bin/bash
set -e

if [ -z "$1" ]; then
    echo "Usage: $0 <production|local>"
    exit 1
fi

echo "Generating configs for $1..."

if [ "$1" == "production" ]; then
    config_file="config.yml"
    wrangler_config_name="wrangler.production.jsonc"
else
    config_file="config.local.yml"
    wrangler_config_name="wrangler.jsonc"
fi

for worker_path in workers/*; do
    if [ -d "$worker_path" ]; then
        worker_name=$(basename "$worker_path")
        echo "Generating config for $worker_name..."
        pnpm exec tsx scripts/generate-wrangler-config.ts "$config_file" "$worker_path/$wrangler_config_name" "worker" "$worker_name"
    fi
done

echo "Generating config for router..."
pnpm exec tsx scripts/generate-wrangler-config.ts "$config_file" "router/example-app-router-worker/$wrangler_config_name" "router" "example-app-router-worker"
