#!/usr/bin/env bash
# Load the root `.env` the way the controller does, for the shell scripts.
#
# `npm run incident` reads `.env` through node's --env-file-if-exists, so a
# stack brought up without reading it can disagree with the controller about
# which port anything is on — move HUSH_KUBERNETES_PORT and `make up` starts the
# proxy on 8001 while the controller polls somewhere else (Qodo, PR #20).
#
# An already-exported variable wins: `HUSH_KUBERNETES_PORT=8002 make up` is how
# you override a run without editing the file.

hush_load_env() {
  local file="${1:-.env}" line key
  [ -f "$file" ] || return 0
  while IFS= read -r line || [ -n "$line" ]; do
    line="${line#"${line%%[![:space:]]*}"}"          # strip leading blanks
    case "$line" in ''|'#'*) continue ;; esac
    case "$line" in *=*) ;; *) continue ;; esac
    key="${line%%=*}"
    key="${key%"${key##*[![:space:]]}"}"             # strip trailing blanks
    # Only plain shell-safe names. This also drops `export FOO=bar`, which node's
    # --env-file does not treat as an assignment either: the two parsers have to
    # agree, or the scripts act on a value the controller never saw.
    case "$key" in ''|*[!A-Za-z0-9_]*) continue ;; esac
    # An `A && continue` here would leave a non-zero status behind under the
    # `set -e` in mcp-up.sh.
    if [ -n "${!key+set}" ]; then continue; fi
    export "$key=${line#*=}"
  done < "$file"
}
