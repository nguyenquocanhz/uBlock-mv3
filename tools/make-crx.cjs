// Package a built extension directory as a signed .crx (CRX3).
//
//   node tools/make-crx.cjs <extensionDir> <output.crx> [privateKey.pem]
//
// The key is generated on first run and reused afterwards, because the
// extension's ID is derived from the public key: lose the key and every
// installed copy is treated as a different extension. Keep it out of the
// repository -- .gitignore already covers *.pem.
//
// CRX3 layout:
//   "Cr24" | uint32le version=3 | uint32le headerLen | CrxFileHeader | zip
//
// and the signature covers
//   "CRX3 SignedData\0" | uint32le len(signedHeaderData) | signedHeaderData | zip

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

/* ---- minimal protobuf writer ------------------------------------------- */

const varint = n => {
    const out = [];
    while ( n > 127 ) { out.push((n & 0x7F) | 0x80); n >>>= 7; }
    out.push(n);
    return Buffer.from(out);
};

// wire type 2 (length-delimited) is the only one used here
const field = (number, payload) => Buffer.concat([
    varint((number << 3) | 2),
    varint(payload.length),
    payload,
]);

const uint32le = n => {
    const b = Buffer.alloc(4);
    b.writeUInt32LE(n, 0);
    return b;
};

/* ---- key ---------------------------------------------------------------- */

const loadOrCreateKey = keyPath => {
    if ( fs.existsSync(keyPath) ) {
        return crypto.createPrivateKey(fs.readFileSync(keyPath));
    }
    const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    fs.mkdirSync(path.dirname(keyPath), { recursive: true });
    fs.writeFileSync(keyPath, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
    process.stderr.write(`make-crx: generated a new signing key at ${keyPath}\n`);
    process.stderr.write(`make-crx: keep it -- the extension ID is derived from it\n`);
    return privateKey;
};

// Chromium writes the id as the first 16 bytes of SHA-256(SubjectPublicKeyInfo),
// hex-encoded, with 0-f shifted into a-p.
const extensionId = derPublicKey => {
    const digest = crypto.createHash('sha256').update(derPublicKey).digest();
    return [ ...digest.subarray(0, 16) ]
        .map(b => b.toString(16).padStart(2, '0'))
        .join('')
        .replace(/[0-9a-f]/g, c => String.fromCharCode(c.charCodeAt(0) + (c <= '9' ? 49 : 10)));
};

/* ---- main --------------------------------------------------------------- */

const zipPath = path.resolve(process.argv[2]);
const outPath = path.resolve(process.argv[3]);
const keyPath = path.resolve(process.argv[4] || path.join(path.dirname(outPath), 'wren-adblock-pro.pem'));

if ( fs.existsSync(zipPath) === false ) {
    process.stderr.write(`make-crx: no such file: ${zipPath}\n`);
    process.exit(1);
}

const zip = fs.readFileSync(zipPath);
const privateKey = loadOrCreateKey(keyPath);
const publicKeyDer = crypto.createPublicKey(privateKey).export({ type: 'spki', format: 'der' });
const id = extensionId(publicKeyDer);

// SignedData { crx_id = 1 }, 16 raw bytes of the same digest the id came from
const crxId = crypto.createHash('sha256').update(publicKeyDer).digest().subarray(0, 16);
const signedHeaderData = field(1, crxId);

const signature = crypto.sign('sha256', Buffer.concat([
    Buffer.from('CRX3 SignedData\0', 'utf8'),
    uint32le(signedHeaderData.length),
    signedHeaderData,
    zip,
]), privateKey);

// CrxFileHeader { sha256_with_rsa = 2, signed_header_data = 10000 }
const header = Buffer.concat([
    field(2, Buffer.concat([ field(1, publicKeyDer), field(2, signature) ])),
    field(10000, signedHeaderData),
]);

fs.writeFileSync(outPath, Buffer.concat([
    Buffer.from('Cr24', 'utf8'),
    uint32le(3),
    uint32le(header.length),
    header,
    zip,
]));

// Read the version out of the packaged manifest rather than anywhere else, so
// update.xml can never claim a version the .crx does not contain.
const manifestVersion = (() => {
    const zlib = require('zlib');
    const localSig = Buffer.from([ 0x50, 0x4b, 0x03, 0x04 ]);
    for ( let i = 0; ; ) {
        i = zip.indexOf(localSig, i);
        if ( i === -1 ) { return null; }
        const method = zip.readUInt16LE(i + 8);
        const compressed = zip.readUInt32LE(i + 18);
        const nameLen = zip.readUInt16LE(i + 26);
        const extraLen = zip.readUInt16LE(i + 28);
        const name = zip.subarray(i + 30, i + 30 + nameLen).toString('utf8');
        const body = zip.subarray(i + 30 + nameLen + extraLen, i + 30 + nameLen + extraLen + compressed);
        if ( name === 'manifest.json' ) {
            const raw = method === 0 ? body : zlib.inflateRawSync(body);
            try { return JSON.parse(raw.toString('utf8')).version; } catch { return null; }
        }
        i += 4;
    }
})();

// Chromium will not install a .crx dragged in from outside a store, but it will
// install one named by enterprise policy. That needs an update manifest, so
// write one next to the .crx with the codebase left for the publisher to fill.
const updateXml = [
    `<?xml version='1.0' encoding='UTF-8'?>`,
    `<gupdate xmlns='http://www.google.com/update2/response' protocol='2.0'>`,
    `  <app appid='${id}'>`,
    `    <updatecheck codebase='https://example.invalid/${path.basename(outPath)}' version='${manifestVersion || '0'}' />`,
    `  </app>`,
    `</gupdate>`,
    ``,
].join('\n');
const updatePath = path.join(path.dirname(outPath), 'update.xml');
fs.writeFileSync(updatePath, updateXml);

process.stdout.write(JSON.stringify({
    crx: outPath,
    bytes: fs.statSync(outPath).size,
    extensionId: id,
    version: manifestVersion,
    key: keyPath,
    updateManifest: updatePath,
}, null, 2) + '\n');
