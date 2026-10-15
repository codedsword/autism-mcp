#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-3.0-only
# Launches the Prism instance on your desktop. The client has no headless mode; it needs your display.
# Account selection stays in Prism: use an offline throwaway account. This script never touches credentials.
source "$(dirname "$0")/lib.sh"
exec flatpak run org.prismlauncher.PrismLauncher --launch "$PRISM_INSTANCE"
