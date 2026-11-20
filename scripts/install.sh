#!/usr/bin/env bash
set -euo pipefail

UUID="amazing-media-control@local"
SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEST_DIR="${HOME}/.local/share/gnome-shell/extensions/${UUID}"

echo "Compiling GSettings schemas..."
glib-compile-schemas "${SRC_DIR}/schemas"

echo "Installing extension to ${DEST_DIR}..."
rm -rf "${DEST_DIR}"
mkdir -p "${DEST_DIR}"
cp -r "${SRC_DIR}/metadata.json" "${SRC_DIR}/extension.js" "${SRC_DIR}/prefs.js" "${SRC_DIR}/stylesheet.css" "${SRC_DIR}/schemas" "${SRC_DIR}/src" "${DEST_DIR}/"

echo "Enabling extension..."
gnome-extensions enable "${UUID}" || true

echo "Done! Log out and back in on Wayland (GNOME 51) if the extension is newly installed."

