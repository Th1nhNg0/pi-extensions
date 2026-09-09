#!/usr/bin/env bash
set -euo pipefail

# Node 20 does not execute .mts files directly. Compile the tests and sources
# into a temporary ESM-scoped tree, then run the emitted JavaScript.
check_dir="$(mktemp -d "${TMPDIR:-/tmp}/pi-ext-test.XXXXXX")"
trap 'rm -rf "$check_dir"' EXIT
printf '{"type":"module"}\n' >"$check_dir/package.json"

./node_modules/.bin/tsc \
	--ignoreConfig \
	--target ES2022 \
	--module NodeNext \
	--moduleResolution NodeNext \
	--lib ES2022 \
	--strict \
	--esModuleInterop \
	--skipLibCheck \
	--outDir "$check_dir" \
	--noEmit false \
	--allowImportingTsExtensions \
	--rewriteRelativeImportExtensions \
	--rootDir . \
	extensions/startup-entry.ts \
	extensions/deferred-extension.ts \
	extensions/subscription-usage.ts \
	extensions/discord-presence.ts \
	tests/*.mts

node --test "$check_dir"/tests/*.mjs
