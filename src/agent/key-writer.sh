#!/bin/sh
# Writes a key X-Nix uploads under /run/keys with its owner, group and mode, reading the contents from stdin, or
# reports whether each named key is there, with its contents hashed after a salt so they never leave the host.
#
#   key-writer.sh write <destination> <owner> <group> <mode>
#   key-writer.sh check <salt> <destination>...
set -eu

# A destination is only ever a plain path under /run/keys.
check_destination() {
  case "$1" in
    /run/keys/*) ;;
    *) echo "$1 is not under /run/keys" >&2; exit 2 ;;
  esac
  case "$1" in
    *..* | *//* | */ | *[!A-Za-z0-9_.@+/-]*) echo "$1 is not a plain path" >&2; exit 2 ;;
  esac
}

case "${1:-}" in
  write)
    [ "$#" = 5 ] || { echo "usage: write <destination> <owner> <group> <mode>" >&2; exit 2; }
    destination=$2
    owner=$3
    group=$4
    mode=$5
    check_destination "$destination"
    folder=$(dirname "$destination")
    mkdir -p "$folder"
    # The part file is made private before anything is written to it, and renamed into place once it is whole.
    part=$(mktemp "$folder/.x-nix-key.XXXXXX")
    trap 'rm -f "$part"' EXIT
    cat > "$part"
    chown "$owner:$group" "$part"
    chmod "$mode" "$part"
    mv -f "$part" "$destination"
    trap - EXIT
    ;;
  check)
    [ "$#" -ge 2 ] || { echo "usage: check <salt> <destination>..." >&2; exit 2; }
    salt=$2
    shift 2
    for destination in "$@"; do
      check_destination "$destination"
      if [ -f "$destination" ]; then
        hash=$({ printf '%s' "$salt"; cat "$destination"; } | sha256sum | cut -d ' ' -f 1)
        echo "present $hash $(stat -c '%s %U %G %a' "$destination") $destination"
      else
        echo "missing $destination"
      fi
    done
    ;;
  *)
    echo "usage: key-writer.sh write|check ..." >&2
    exit 2
    ;;
esac
