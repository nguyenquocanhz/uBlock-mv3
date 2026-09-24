// A `jq` replacement for building on Windows, covering only the filters
// tools/make-mv3.sh actually uses. It is not a jq implementation and will
// refuse anything it does not recognise rather than guess:
//
//   jq -r .version FILE
//   jq '.permissions += ["x"]' FILE
//   jq '.optional_permissions -= ["x"]' FILE
//   jq '.browser_specific_settings.gecko.id = "x"' FILE
//   jq --arg version "V" '.version = $version' FILE
//
// Install the real thing (winget install jqlang.jq) and this is never used.

const fs = require('fs');

const argv = process.argv.slice(2);
let raw = false;
const vars = {};
const rest = [];
for ( let i = 0; i < argv.length; i++ ) {
    const a = argv[i];
    if ( a === '-r' || a === '--raw-output' ) { raw = true; continue; }
    if ( a === '--arg' ) { vars[argv[i+1]] = argv[i+2]; i += 2; continue; }
    rest.push(a);
}
const filter = rest[0];
const file = rest[1];
const data = JSON.parse(fs.readFileSync(file, 'utf8'));

const dig = (obj, dotted, create) => {
    const parts = dotted.split('.');
    let o = obj;
    for ( let i = 0; i < parts.length - 1; i++ ) {
        if ( o[parts[i]] === undefined ) {
            if ( create !== true ) { return [ undefined, undefined ]; }
            o[parts[i]] = {};
        }
        o = o[parts[i]];
    }
    return [ o, parts[parts.length-1] ];
};

const value = token => {
    const t = token.trim();
    if ( t.startsWith('$') ) { return vars[t.slice(1)]; }
    return JSON.parse(t);
};

let out;
let m;
if ( (m = /^\.([\w.]+)\s*-=\s*(.+)$/.exec(filter)) ) {
    const [ o, k ] = dig(data, m[1], false);
    const remove = value(m[2]);
    if ( o !== undefined && Array.isArray(o[k]) ) {
        o[k] = o[k].filter(v => remove.includes(v) === false);
    }
    out = data;
} else if ( (m = /^\.([\w.]+)\s*\+=\s*(.+)$/.exec(filter)) ) {
    const [ o, k ] = dig(data, m[1], true);
    o[k] = (o[k] || []).concat(value(m[2]));
    out = data;
} else if ( (m = /^\.([\w.]+)\s*=\s*(.+)$/.exec(filter)) ) {
    const [ o, k ] = dig(data, m[1], true);
    o[k] = value(m[2]);
    out = data;
} else if ( (m = /^\.([\w.]+)$/.exec(filter)) ) {
    const [ o, k ] = dig(data, m[1], false);
    out = o === undefined ? null : o[k];
} else {
    process.stderr.write(`jq.cjs: unsupported filter: ${filter}\n`);
    process.exit(2);
}

process.stdout.write(
    raw && typeof out !== 'object'
        ? `${out}\n`
        : `${JSON.stringify(out, null, 2)}\n`
);
