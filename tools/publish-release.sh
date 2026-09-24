#!/usr/bin/env bash
#
# Publish a finished build as a GitHub release and refresh the update server.
#
#   tools/publish-release.sh <tag> [signing-key.pem]
#
# Expects dist/build/WrenAdBlockPro.chromium and the matching
# dist/build/WrenAdBlockPro_<version>.chromium.zip from tools/make-mv3.sh.
#
# 1. Signs the .crx, with update.xml pointing at where the release serves it.
# 2. Attaches the .zip and .crx to release <tag>, creating the release if it
#    does not exist and otherwise adding only what is missing. If the release
#    already carries a .zip of the same name, it must be byte-identical to the
#    local one -- the .crx is signed over the local file, so a mismatch would
#    publish an update manifest that does not describe the release.
# 3. Writes update.xml and the release page to the gh-pages branch, building
#    the commit with git plumbing so the working tree is never touched.
# 4. Turns on GitHub Pages for gh-pages the first time.
#
# Only browsers that installed the extension through policy ever read
# update.xml. A copy loaded unpacked does not update itself.

set -euo pipefail

TAG="${1:?usage: tools/publish-release.sh <tag> [signing-key.pem]}"
KEY="${2:-$HOME/.wren-adblock-pro-signing.pem}"
# node on Windows reads /c/Users/... as D:\\c\\Users\\..., so hand it a
# native path. make-crx refuses to invent a key, but better not to ask it to.
KEY_NATIVE="$(cygpath -w "$KEY" 2>/dev/null || printf '%s' "$KEY")"

# DRY_RUN=1 signs and renders everything locally but changes nothing on GitHub.
DRY_RUN="${DRY_RUN:-}"
run() { if [ -n "$DRY_RUN" ]; then echo "dry-run  would: $*"; else "$@"; fi; }
# Report an outcome only when it actually happened.
done_() { [ -n "$DRY_RUN" ] || echo "$@"; }

cd "$(dirname "${BASH_SOURCE[0]}")/.."

BRAND="WrenAdBlockPro"
DIR="dist/build/$BRAND.chromium"
[ -f "$DIR/manifest.json" ] || { echo "no build at $DIR -- run tools/make-mv3.sh first" >&2; exit 1; }

VERSION="$(node -p "require('./$DIR/manifest.json').version")"
ZIP="dist/build/${BRAND}_${VERSION}.chromium.zip"
CRX="dist/build/${BRAND}_${VERSION}.crx"
[ -f "$ZIP" ] || { echo "no package at $ZIP" >&2; exit 1; }

REPO="$(gh repo view --json nameWithOwner -q .nameWithOwner)"
OWNER="${REPO%%/*}"
NAME="${REPO##*/}"
PAGES_URL="https://$(printf '%s' "$OWNER" | tr '[:upper:]' '[:lower:]').github.io/$NAME"
UPDATE_URL="$PAGES_URL/update.xml"
RELEASE_URL="https://github.com/$REPO/releases/tag/$TAG"
CRX_URL="https://github.com/$REPO/releases/download/$TAG/$(basename "$CRX")"
ZIP_URL="https://github.com/$REPO/releases/download/$TAG/$(basename "$ZIP")"

echo "release  $REPO $TAG  (extension $VERSION)"

# ---- 1. sign ---------------------------------------------------------------

EXT_ID="$(node tools/make-crx.cjs "$ZIP" "$CRX" "$KEY_NATIVE" --codebase="$CRX_URL" \
    | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>process.stdout.write(JSON.parse(s).extensionId))")"
echo "signed   $CRX  (id $EXT_ID)"

# ---- 2. release ------------------------------------------------------------

sha() { sha256sum "$1" | cut -d' ' -f1; }

if gh release view "$TAG" -R "$REPO" >/dev/null 2>&1; then
    existing="$(gh release view "$TAG" -R "$REPO" --json assets -q '.assets[].name')"
    if printf '%s\n' "$existing" | grep -qxF "$(basename "$ZIP")"; then
        tmp="$(mktemp -d)"
        gh release download "$TAG" -R "$REPO" -p "$(basename "$ZIP")" -D "$tmp" >/dev/null
        if [ "$(sha "$tmp/$(basename "$ZIP")")" != "$(sha "$ZIP")" ]; then
            rm -rf "$tmp"
            echo "the $(basename "$ZIP") on $TAG differs from the local one;" >&2
            echo "refusing to publish a .crx that does not match the release" >&2
            exit 1
        fi
        rm -rf "$tmp"
        echo "release  $TAG already has an identical $(basename "$ZIP")"
    fi
    for f in "$ZIP" "$CRX"; do
        if printf '%s\n' "$existing" | grep -qxF "$(basename "$f")"; then
            echo "release  keeping existing $(basename "$f")"
        else
            run gh release upload "$TAG" "$f" -R "$REPO"
            done_ "release  uploaded $(basename "$f")"
        fi
    done
else
    run gh release create "$TAG" "$ZIP" "$CRX" -R "$REPO" \
        --title "Wren AdBlock Pro $VERSION" \
        --notes "Extension version \`$VERSION\`. Install instructions: $PAGES_URL/"
    done_ "release  created $TAG"
fi

# ---- 3. pages --------------------------------------------------------------

SITE="dist/build/pages"
rm -rf "$SITE"
mkdir -p "$SITE"
cp "dist/build/update.xml" "$SITE/update.xml"
: > "$SITE/.nojekyll"

node - "$SITE/index.html" <<NODE
const fs = require('fs');
const svg = fs.readFileSync('platform/mv3/extension/img/wren.svg', 'utf8')
    .replace(/<!--[\s\S]*?-->/g, '').replace(/\n\s*\n/g, '\n').trim();
const fill = {
    VERSION: '$VERSION',
    TAG: '$TAG',
    DATE: new Date().toISOString().slice(0, 10),
    EXT_ID: '$EXT_ID',
    CRX_URL: '$CRX_URL',
    ZIP_URL: '$ZIP_URL',
    UPDATE_URL: '$UPDATE_URL',
    RELEASE_URL: '$RELEASE_URL',
    REPO_URL: 'https://github.com/$REPO',
    LOGO_SVG: svg,
    LOGO_URI: encodeURIComponent(svg),
};
let html = fs.readFileSync('tools/pages/index.template.html', 'utf8');
html = html.replace(/\{\{(\w+)\}\}/g, (m, k) => {
    if ( k in fill === false ) { throw new Error('unfilled placeholder ' + m); }
    return fill[k];
});
fs.writeFileSync(process.argv[2], html);
NODE

# Build the gh-pages commit from blobs directly. The site is flat, so one
# tree is enough, and nothing about the current checkout changes.
tree_input=""
for f in "$SITE"/.nojekyll "$SITE"/index.html "$SITE"/update.xml; do
    blob="$(git hash-object -w "$f")"
    tree_input+="100644 blob $blob	$(basename "$f")"$'\n'
done
tree="$(printf '%s' "$tree_input" | git mktree)"

parent=""
if git ls-remote --exit-code --heads origin gh-pages >/dev/null 2>&1; then
    git fetch -q origin gh-pages
    parent="$(git rev-parse FETCH_HEAD)"
fi

if [ -n "$parent" ] && [ "$(git rev-parse "$parent^{tree}")" = "$tree" ]; then
    echo "pages    unchanged"
else
    commit="$(git commit-tree "$tree" ${parent:+-p "$parent"} -m "Publish $VERSION ($TAG)")"
    run git push -q origin "$commit:refs/heads/gh-pages"
    done_ "pages    pushed $commit"
fi

# ---- 4. enable Pages once --------------------------------------------------

if ! gh api "repos/$REPO/pages" >/dev/null 2>&1; then
    run gh api -X POST "repos/$REPO/pages" \
        -f 'source[branch]=gh-pages' -f 'source[path]=/'
    done_ "pages    enabled on gh-pages"
fi

echo
echo "page     $PAGES_URL/"
echo "update   $UPDATE_URL"
echo "crx      $CRX_URL"
echo "policy   $EXT_ID;$UPDATE_URL"
