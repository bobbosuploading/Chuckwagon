#!/usr/bin/env bash
# Fails when CHANGES.txt has no section for the build number in ios/project.yml,
# or when that section is too long for TestFlight's "What to Test" box (4,000 characters).
set -euo pipefail
cd "$(dirname "$0")/.."

build=$(sed -n 's/^ *CURRENT_PROJECT_VERSION: *"\{0,1\}\([0-9][0-9]*\)"\{0,1\} *$/\1/p' ios/project.yml | head -1)
if [ -z "$build" ]; then
  echo "Could not read CURRENT_PROJECT_VERSION from ios/project.yml" >&2
  exit 1
fi

if ! grep -Eq "^Build $build( |\$)" CHANGES.txt; then
  echo "CHANGES.txt has no \"Build $build\" section." >&2
  echo "Add one at the top of the list saying what's new in build $build." >&2
  exit 1
fi

# The section's text: after its heading's closing ==== line, up to the next ==== line.
chars=$(awk -v b="$build" '
  $0 ~ "^Build " b "( |$)" { found = 1; next }
  found && /^====/ { if (started) exit; started = 1; next }
  found && started { print }
' CHANGES.txt | grep -v '^\[' | wc -m)
if [ "$chars" -gt 4000 ]; then
  echo "The Build $build section is $chars characters; TestFlight allows 4,000." >&2
  exit 1
fi

echo "CHANGES.txt covers build $build ($chars characters)."
