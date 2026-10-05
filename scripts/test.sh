#!/usr/bin/env bash
set -euo pipefail

# Node 20 does not execute .mts files directly. Compile the tests and sources
# into a temporary ESM-scoped tree, then run the emitted JavaScript.
check_dir="$(mktemp -d "${TMPDIR:-/tmp}/pi-ext-test.XXXXXX")"
trap 'rm -rf "$check_dir"' EXIT
printf '{"type":"module"}\n' >"$check_dir/package.json"

# Extensions load @narumitw/pi-tui-kit only when a menu opens. The compiled
# tree gets a stub so the menu wiring is testable without the TUI runtime; it
# records every runMenu call in `menuRuns`, and tests resolve the same module
# instance the extensions do.
mkdir -p "$check_dir/node_modules/@narumitw/pi-tui-kit"
cat >"$check_dir/node_modules/@narumitw/pi-tui-kit/package.json" <<'STUB'
{
	"name": "@narumitw/pi-tui-kit",
	"version": "0.0.0-test",
	"type": "module",
	"exports": { ".": "./index.js" }
}
STUB
cat >"$check_dir/node_modules/@narumitw/pi-tui-kit/index.js" <<'STUB'
export const menuRuns = [];
export function defineMenu(definition) {
	return definition;
}
export async function runMenu(ctx, definition, options) {
	menuRuns.push({ ctx, definition, options });
	return { kind: "closed", reason: "close" };
}
STUB

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
	extensions/live-throughput-status.ts \
	extensions/prompt-rewriter.ts \
	extensions/shared/command-kit.ts \
	extensions/shared/settings-menu.ts \
	tests/*.mts

node --test "$check_dir"/tests/*.mjs
