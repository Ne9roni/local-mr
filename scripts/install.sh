#!/usr/bin/env bash

set -euo pipefail
umask 077

usage() {
    cat <<'EOF'
Usage: scripts/install.sh [--link]

Install local-mr below ${LOCAL_MR_PREFIX:-$HOME/.local}.

  --link    Link the command and runtime to this checkout for development.
            The default creates a self-contained copy with production dependencies.
EOF
}

mode=copy
if (($# > 0)); then
    case "$1" in
        --link)
            mode=link
            shift
            ;;
        -h|--help)
            usage
            exit 0
            ;;
        *)
            printf 'install.sh: unknown option: %s\n' "$1" >&2
            exit 2
            ;;
    esac
fi
(($# == 0)) || { usage >&2; exit 2; }

script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
repo_root=$(cd -- "$script_dir/.." && pwd)
prefix=${LOCAL_MR_PREFIX:-$HOME/.local}
bin_dir=$prefix/bin
share_parent=$prefix/share
share_dir=$share_parent/local-mr
command_path=$bin_dir/local-mr

command -v node >/dev/null 2>&1 || { echo "install.sh: Node.js >=22 is required" >&2; exit 1; }
command -v npm >/dev/null 2>&1 || { echo "install.sh: npm is required" >&2; exit 1; }

node -e '
    const major = Number(process.versions.node.split(".")[0]);
    if (major < 22) throw new Error(`Node.js >=22 is required; found ${process.version}`);
'

mkdir -p "$bin_dir" "$share_parent"

replace_with_link() {
    local target=$1
    local source=$2
    local temporary="${target}.new.$$"
    local backup="${target}.old.$$"

    rm -f "$temporary"
    ln -s "$source" "$temporary"
    if [[ -e "$target" || -L "$target" ]]; then
        mv "$target" "$backup"
    fi
    mv "$temporary" "$target"
    rm -rf "$backup"
}

if [[ "$mode" == link ]]; then
    (cd "$repo_root" && npm ci)
    replace_with_link "$share_dir" "$repo_root"
    replace_with_link "$command_path" "$repo_root/bin/local-mr"
else
    stage=$(mktemp -d "$share_parent/.local-mr-stage.XXXXXXXX")
    cleanup() { rm -rf "$stage"; }
    trap cleanup EXIT
    mkdir -p "$stage/src" "$stage/skills"
    install -m 0644 \
        "$repo_root/package.json" \
        "$repo_root/package-lock.json" \
        "$repo_root/LICENSE" \
        "$repo_root/THIRD_PARTY_NOTICES.md" \
        "$stage/"
    install -m 0644 "$repo_root"/src/* "$stage/src/"
    cp -R "$repo_root"/skills/. "$stage/skills/"
    sha256sum "$repo_root/bin/local-mr" | cut -d' ' -f1 > "$stage/.command-sha256"
    (cd "$stage" && npm ci --omit=dev)

    backup="${share_dir}.old.$$"
    if [[ -e "$share_dir" || -L "$share_dir" ]]; then
        mv "$share_dir" "$backup"
    fi
    mv "$stage" "$share_dir"
    stage=""
    rm -rf "$backup"

    command_temp="${command_path}.new.$$"
    install -m 0755 "$repo_root/bin/local-mr" "$command_temp"
    mv -f "$command_temp" "$command_path"
fi

printf 'Installed local-mr (%s mode)\n' "$mode"
printf 'Command: %s\n' "$command_path"
printf 'Runtime: %s\n' "$share_dir"
