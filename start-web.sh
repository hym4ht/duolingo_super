#!/usr/bin/env bash
set -euo pipefail

normalize_bool() {
    local raw="${1:-}"
    raw="$(printf '%s' "$raw" | tr '[:upper:]' '[:lower:]' | xargs)"
    case "$raw" in
        1|true|yes|on) printf 'true' ;;
        0|false|no|off) printf 'false' ;;
        *) printf '' ;;
    esac
}

headless="$(normalize_bool "${HEADLESS:-}")"
force_headed_login="$(normalize_bool "${FORCE_HEADED_LOGIN:-}")"
manual_password="$(normalize_bool "${MANUAL_PASSWORD:-}")"

if [[ "$headless" == "false" || "$force_headed_login" == "true" || "$manual_password" == "true" ]]; then
    if ! command -v xvfb-run >/dev/null 2>&1; then
        echo "[BOOT] xvfb-run tidak ditemukan, padahal runtime membutuhkan display virtual." >&2
        exit 1
    fi

    echo "[BOOT] Menjalankan web server dengan xvfb-run"
    exec xvfb-run -a --server-args="-screen 0 1280x800x24" node server.js
fi

echo "[BOOT] Menjalankan web server tanpa xvfb"
exec node server.js
