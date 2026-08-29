#!/usr/bin/env bash
# Load the root `.env` the way node's --env-file does, for the shell scripts.
#
# `npm run incident` reads `.env` through node's --env-file-if-exists, so a
# stack brought up without reading it can disagree with the controller about
# which port anything is on — move HUSH_KUBERNETES_PORT and `make up` starts the
# proxy on 8001 while the controller polls somewhere else (Qodo, PR #20).
#
# Matching node matters as much as reading the file at all: a loader that
# disagrees about quoting or trailing comments reintroduces the same divergence
# from the other side. The rules below were read off node itself, not guessed:
#
#   PLAIN=one              -> one
#   export EXPORTED=two    -> two          (node accepts the prefix)
#   QUOTED="three"         -> three        (matched quotes are stripped)
#   SINGLE='four'          -> four
#   TRAILING=five␠␠␠       -> five         (unquoted values are trimmed)
#   HASH=six # comment     -> six          (and so is a trailing comment)
#   BARE=six#nospace       -> six          (no space needed before the #)
#   IN_QUOTES="has # hash" -> has # hash   (quoting protects it)
#
# Not supported: a quote opened on one line and closed on another. node reads
# those as one multi-line value; rather than guess differently, this skips the
# line and says so, so the two can never silently disagree.
#
# An already-exported variable wins: `HUSH_KUBERNETES_PORT=8002 make up` is how
# you override a run without editing the file.

hush_load_env() {
  local file="${1:-.env}" line key value quote
  [ -f "$file" ] || return 0
  while IFS= read -r line || [ -n "$line" ]; do
    line="${line%$'\r'}"                                   # tolerate CRLF
    line="${line#"${line%%[![:space:]]*}"}"                # strip leading blanks
    case "$line" in ''|'#'*) continue ;; esac
    case "$line" in 'export '*) line="${line#export }"
                                line="${line#"${line%%[![:space:]]*}"}" ;; esac
    case "$line" in *=*) ;; *) continue ;; esac

    key="${line%%=*}"
    key="${key%"${key##*[![:space:]]}"}"                   # strip trailing blanks
    case "$key" in ''|*[!A-Za-z0-9_]*) continue ;; esac

    value="${line#*=}"
    value="${value#"${value%%[![:space:]]*}"}"             # strip leading blanks
    case "$value" in
      \"*|\'*)
        quote="${value:0:1}"
        value="${value:1}"
        case "$value" in
          *"$quote"*) value="${value%%"$quote"*}" ;;
          *) echo "  $file: $key opens a quote it does not close on one line; skipped" >&2
             continue ;;
        esac
        ;;
      *)
        value="${value%%#*}"                               # trailing comment
        value="${value%"${value##*[![:space:]]}"}"         # strip trailing blanks
        ;;
    esac

    if [ -n "${!key+set}" ]; then continue; fi
    export "$key=$value"
  done < "$file"
}
