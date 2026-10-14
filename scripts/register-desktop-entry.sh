#!/usr/bin/env bash

#---------------------------------------------------------------------------------------------
#  Copyright (c) Magis. All rights reserved.
#  Licensed under the MIT License. See License.txt in the project root for license information.
#---------------------------------------------------------------------------------------------

set -euo pipefail

if [[ "$OSTYPE" == "darwin"* ]]; then
	realpath() { [[ $1 = /* ]] && echo "$1" || echo "$PWD/${1#./}"; }
	ROOT=$(dirname "$(dirname "$(realpath "$0")")")
else
	ROOT=$(dirname "$(dirname "$(readlink -f "$0")")")
fi

if [[ -n "${SNAP_REAL_HOME:-}" ]]; then
	APPLICATIONS_DIR="$SNAP_REAL_HOME/.local/share/applications"
else
	APPLICATIONS_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/applications"
fi
DESKTOP_FILE="$APPLICATIONS_DIR/magis-ide-dev.desktop"

mkdir -p "$APPLICATIONS_DIR"

printf '%s\n' \
	'[Desktop Entry]' \
	'Version=1.0' \
	'Type=Application' \
	'Name=Magis IDE (Development)' \
	'Comment=Professional code editor' \
	"Exec=$ROOT/scripts/code.sh %F" \
	"Icon=$ROOT/resources/linux/magis.png" \
	'StartupWMClass=magis-ide' \
	'StartupNotify=true' \
	'Categories=Development;IDE;' \
	'MimeType=application/x-magis-ide-workspace;' \
	'Keywords=magis;editor;ide;' \
	> "$DESKTOP_FILE"

if command -v desktop-file-validate >/dev/null 2>&1; then
	desktop-file-validate "$DESKTOP_FILE"
fi

if command -v update-desktop-database >/dev/null 2>&1; then
	update-desktop-database "$APPLICATIONS_DIR"
fi

echo "Registered development launcher: $DESKTOP_FILE"
