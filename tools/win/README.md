# Building on Windows

`tools/make-mv3.sh` says it assumes a Linux environment, and two of the
things it assumes are missing from Git Bash: `jq` and `zip`. This directory
supplies stand-ins so the build runs unmodified.

    export PATH="$PWD/tools/win/bin:$PATH"
    ./tools/make-mv3.sh chromium 2026.924.1226

What is here:

- `bin/jq` → `jq.cjs`, covering only the four filters the build script uses.
  It refuses anything else rather than guessing.
- `bin/zip` → `zip.cjs`, a ZIP writer. PowerShell's `Compress-Archive` is not
  usable here: on .NET Framework it writes entry names like `js\popup.js`, and
  a backslash separator makes the archive invalid for the extension stores.
- `bin/node` bridges paths. The build script passes POSIX paths such as
  `output=/d/uBlock/dist/...`, which `node.exe` resolves against the wrong
  drive.

None of this is needed if you install the real tools:

    winget install jqlang.jq GnuWin32.Zip

The wrappers find the real `node` by removing their own directory from PATH
first, so putting `bin` ahead of everything else is safe.
