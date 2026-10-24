#!/bin/bash
# Build the SIPNET WebAssembly web runner and push it, as a build artifact, to
# a dedicated branch (default: wasm-site-build). Pushing that branch triggers
# the "WASM site artifact" workflow, which in turn triggers "Publish Docs";
# that workflow builds the docs and deploys them to GitHub Pages with the web
# runner from this branch under app/.
#
# The artifact branch holds only built files (one commit per publish, each
# recording the source commit), never sources.
#
# Usage: tools/publish_wasm_site.sh      (or: make wasm-publish)
# Environment:
#   REMOTE=origin            remote to push to
#   BRANCH=wasm-site-build   artifact branch name
#   DRY_RUN=1                build and create the commit locally, but don't push
#   FORCE=1                  allow publishing from a tree with uncommitted changes
#
# Requires emcc (Emscripten) and node; see docs/web-assembly.md.

set -euo pipefail

cd "$(dirname "$0")/.."
REMOTE=${REMOTE:-origin}
BRANCH=${BRANCH:-wasm-site-build}

if [ -z "${FORCE:-}" ] && ! git diff-index --quiet HEAD --; then
  echo "error: uncommitted changes; commit them first or set FORCE=1" >&2
  exit 1
fi
if ! command -v emcc > /dev/null; then
  echo "error: emcc not found; install and activate the Emscripten SDK" >&2
  exit 1
fi

# Fresh build of the site
make wasm-clean
make wasm-site

SRC_SHA=$(git rev-parse HEAD)
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
STAGE="$TMP/site"
mkdir -p "$STAGE"

# Runtime files only (not the build scripts)
cp -R web/index.html web/style.css web/js web/sipnet.mjs web/sipnet.wasm \
  web/examples web/examples.json web/param-info.json web/output-info.json \
  "$STAGE/"
touch "$STAGE/.nojekyll"
cat > "$STAGE/BUILD_INFO.txt" << INFO
SIPNET WebAssembly web runner
Source commit: $SRC_SHA
Built: $(date -u +%Y-%m-%dT%H:%M:%SZ)
$(emcc --version | head -n 1)
INFO

# Build the artifact commit with git plumbing, so neither the working tree nor
# the index of this checkout is touched. Previous builds (if any) become the
# parent, giving the artifact branch a linear history.
PARENT_ARGS=()
if git fetch --quiet --depth 1 "$REMOTE" "$BRANCH" 2> /dev/null; then
  PARENT_ARGS=(-p "$(git rev-parse FETCH_HEAD)")
else
  echo "Branch $BRANCH not found on $REMOTE; creating it"
fi
export GIT_INDEX_FILE="$TMP/index"
git --work-tree="$STAGE" add --all --force
TREE=$(git write-tree)
COMMIT=$(git commit-tree "$TREE" "${PARENT_ARGS[@]}" \
  -m "Build SIPNET web runner from ${SRC_SHA:0:10}" \
  -m "Source commit: $SRC_SHA")
unset GIT_INDEX_FILE

echo "Created artifact commit $COMMIT:"
git ls-tree -r --name-only "$COMMIT" | sed 's/^/  /' | head -n 20
echo "  ($(git ls-tree -r --name-only "$COMMIT" | wc -l | tr -d ' ') files)"

if [ -n "${DRY_RUN:-}" ]; then
  echo "DRY_RUN set; not pushing. Inspect with: git show --stat $COMMIT"
  exit 0
fi

git push "$REMOTE" "$COMMIT:refs/heads/$BRANCH"
echo "Pushed to $REMOTE/$BRANCH; GitHub Actions will publish it with the docs."
