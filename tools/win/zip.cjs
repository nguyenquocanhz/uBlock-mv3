// A `zip` replacement for building on Windows.
//
// tools/make-mv3.sh calls `zip`, which Git Bash does not ship. The obvious
// substitute, PowerShell's Compress-Archive (and .NET's
// ZipFile::CreateFromDirectory beneath it), writes entry names like
// "js\popup.js" on .NET Framework. A backslash is not a valid separator in a
// ZIP entry name and the extension stores reject the archive, so the archive
// is written here instead, where the names are ours.
//
//   node tools/win/zip.cjs <sourceDir> <output.zip> [excludeRelativePath ...]

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const crcTable = (() => {
    const t = new Int32Array(256);
    for ( let n = 0; n < 256; n++ ) {
        let c = n;
        for ( let k = 0; k < 8; k++ ) {
            c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
        }
        t[n] = c;
    }
    return t;
})();

const crc32 = buf => {
    let c = ~0;
    for ( let i = 0; i < buf.length; i++ ) {
        c = crcTable[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
    }
    return (~c) >>> 0;
};

const walk = (dir, base, out = []) => {
    for ( const entry of fs.readdirSync(dir, { withFileTypes: true }) ) {
        const full = path.join(dir, entry.name);
        if ( entry.isDirectory() ) {
            walk(full, base, out);
        } else if ( entry.isFile() ) {
            out.push({ full, name: path.relative(base, full).split(path.sep).join('/') });
        }
    }
    return out;
};

const srcDir = path.resolve(process.argv[2]);
const outPath = path.resolve(process.argv[3]);
const exclude = new Set(process.argv.slice(4));

const files = walk(srcDir, srcDir)
    .filter(f => exclude.has(f.name) === false)
    .sort((a, b) => a.name < b.name ? -1 : 1);

// A fixed timestamp would be nicer for reproducible builds, but the stores
// reject archives dated before 1980 and the manifest carries the real version.
const now = new Date();
const time = ((now.getHours() & 0x1F) << 11) |
             ((now.getMinutes() & 0x3F) << 5) |
             ((Math.floor(now.getSeconds() / 2)) & 0x1F);
const date = (((now.getFullYear() - 1980) & 0x7F) << 9) |
             (((now.getMonth() + 1) & 0x0F) << 5) |
             (now.getDate() & 0x1F);

const chunks = [];
const central = [];
let offset = 0;

for ( const file of files ) {
    const raw = fs.readFileSync(file.full);
    const deflated = zlib.deflateRawSync(raw, { level: 9 });
    // Storing beats deflating for already-compressed payloads (png, woff2).
    const stored = deflated.length >= raw.length;
    const body = stored ? raw : deflated;
    const method = stored ? 0 : 8;
    const crc = crc32(raw);
    const name = Buffer.from(file.name, 'utf8');
    const flags = 0x0800;   // bit 11: the entry name is UTF-8

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034B50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    chunks.push(local, name, body);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014B50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(flags, 8);
    cd.writeUInt16LE(method, 10);
    cd.writeUInt16LE(time, 12);
    cd.writeUInt16LE(date, 14);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(body.length, 20);
    cd.writeUInt32LE(raw.length, 24);
    cd.writeUInt16LE(name.length, 28);
    cd.writeUInt16LE(0, 30);
    cd.writeUInt16LE(0, 32);
    cd.writeUInt16LE(0, 34);
    cd.writeUInt16LE(0, 36);
    // Unix mode 0644 in the high word. `<<` produces a signed int32, so the
    // result must be coerced back to unsigned or writeUInt32LE throws.
    cd.writeUInt32LE((0o100644 << 16) >>> 0, 38);
    cd.writeUInt32LE(offset, 42);
    central.push(cd, name);

    offset += local.length + name.length + body.length;
}

const cdBuf = Buffer.concat(central);
const eocd = Buffer.alloc(22);
eocd.writeUInt32LE(0x06054B50, 0);
eocd.writeUInt16LE(0, 4);
eocd.writeUInt16LE(0, 6);
eocd.writeUInt16LE(files.length, 8);
eocd.writeUInt16LE(files.length, 10);
eocd.writeUInt32LE(cdBuf.length, 12);
eocd.writeUInt32LE(offset, 16);
eocd.writeUInt16LE(0, 20);

fs.writeFileSync(outPath, Buffer.concat([ ...chunks, cdBuf, eocd ]));
process.stderr.write(`zip.cjs: ${files.length} entries -> ${outPath}\n`);
