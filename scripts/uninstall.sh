#!/usr/bin/env bash

set -euo pipefail

script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
repo_root=$(cd -- "$script_dir/.." && pwd)
prefix=${LOCAL_MR_PREFIX:-$HOME/.local}
command_path=$prefix/bin/local-mr
share_dir=$prefix/share/local-mr
receipt_path=$share_dir/.command-sha256

command_matches_receipt() {
    [[ -f "$command_path" && -f "$receipt_path" ]] || return 1
    local expected
    local actual
    expected=$(tr -d '[:space:]' < "$receipt_path")
    [[ "$expected" =~ ^[a-f0-9]{64}$ ]] || return 1
    actual=$(sha256sum "$command_path" | cut -d' ' -f1)
    [[ "$actual" == "$expected" ]]
}

if [[ -L "$command_path" && "$(readlink -f "$command_path")" == "$repo_root/bin/local-mr" ]]; then
    rm -f "$command_path"
elif [[ -f "$command_path" ]] && (
    cmp -s "$command_path" "$repo_root/bin/local-mr" || command_matches_receipt
); then
    rm -f "$command_path"
elif [[ -e "$command_path" || -L "$command_path" ]]; then
    echo "uninstall.sh: refusing to remove an unrelated $command_path" >&2
    exit 1
fi

if [[ -L "$share_dir" && "$(readlink -f "$share_dir")" == "$repo_root" ]]; then
    rm -f "$share_dir"
elif [[ -f "$share_dir/package.json" ]] && node -e '
    const manifest = require(process.argv[1]);
    process.exit(manifest.name === "local-mr" ? 0 : 1);
' "$share_dir/package.json"; then
    rm -rf "$share_dir"
elif [[ -e "$share_dir" || -L "$share_dir" ]]; then
    echo "uninstall.sh: refusing to remove an unrelated $share_dir" >&2
    exit 1
fi

echo "Removed local-mr command and runtime. Read-state files were preserved."
