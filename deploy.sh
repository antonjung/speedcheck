#!/usr/bin/env bash
# Bumps the patch version, keeps BUILD_VERSION/CACHE_NAME in sync, commits and
# pushes to main. GitHub Pages redeploys automatically on push.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"

if [ -n "$(git status --porcelain -- . ':!VERSION' ':!app.js' ':!sw.js')" ]; then
  echo "Uncommitted changes outside version files — commit or stash them first." >&2
  git status --short
  exit 1
fi

current="$(cat VERSION)"
IFS='.' read -r major minor patch <<< "$current"
new="$major.$minor.$((patch + 1))"

echo "$new" > VERSION
sed -i "s/BUILD_VERSION = \"[^\"]*\"/BUILD_VERSION = \"$new\"/" app.js
sed -i "s/CACHE_NAME = \"speedcheck-[^\"]*\"/CACHE_NAME = \"speedcheck-$new\"/" sw.js

git add VERSION app.js sw.js
git commit -m "Deploy v$new"
git push

echo "Deployed v$new"
