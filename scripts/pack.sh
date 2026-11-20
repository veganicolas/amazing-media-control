#!/usr/bin/env bash
set -euo pipefail

SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${SRC_DIR}"

gnome-extensions pack \
  --force \
  --extra-source=src \
  --schema=schemas/org.gnome.shell.extensions.amazing-media-control.gschema.xml \
  .

echo "Package created: amazing-media-control@local.shell-extension.zip"

