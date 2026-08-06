#!/usr/bin/env node
/* =============================================================================
 * NODE PORTAL  -  single file server + admin console
 * -----------------------------------------------------------------------------
 * Zero npm dependencies. Zero CDN. Everything is generated from this file.
 *
 *   node server.js              first run: installs itself, hands off to systemd
 *   node server.js --foreground stay in the terminal (dev)
 *   node server.js --smoke-test boot, bind a random port, exit 0 (used by Update)
 *
 * Creates ./Server next to this file and keeps all state there.
 * ========================================================================== */

'use strict';

const http         = require('http');
const fs           = require('fs');
const fsp          = fs.promises;
const path         = require('path');
const os           = require('os');
const crypto       = require('crypto');
const zlib         = require('zlib');
const net          = require('net');
const { spawn, spawnSync, execSync, exec } = require('child_process');

/* --------------------------------------------------------------------------
 * Paths
 * ----------------------------------------------------------------------- */
const SELF        = path.resolve(__filename);
const ROOT        = path.dirname(SELF);
const SRV         = path.join(ROOT, 'Server');
const DATA        = path.join(SRV, 'data');
const PUBLIC      = path.join(SRV, 'public');
const LOGS        = path.join(SRV, 'logs');
const TMP         = path.join(SRV, 'tmp');
const BK_SERVER   = path.join(SRV, 'backups', 'server');
const BK_CADDY    = path.join(SRV, 'backups', 'caddy');
const UPLOADS     = path.join(SRV, 'files');

const F = {
    admin      : path.join(DATA, 'admin.enc'),
    key        : path.join(DATA, '.machine.key'),
    sessions   : path.join(DATA, 'sessions.json'),
    stats      : path.join(DATA, 'stats.json'),
    shares     : path.join(DATA, 'shares.json'),
    apis       : path.join(DATA, 'apis.json'),
    settings   : path.join(DATA, 'settings.json'),
    pending    : path.join(DATA, 'update-pending.json'),
    report     : path.join(DATA, 'update-report.json'),
    installed  : path.join(DATA, '.installed'),
    apilog     : path.join(LOGS, 'api.log'),
    bootlog    : path.join(LOGS, 'bootstrap.log')
};

const PORT      = 8080;
const SERVICE   = 'nodeportal';
const CADDYFILE = '/etc/caddy/Caddyfile';
const FOREGROUND = process.argv.includes('--foreground');
const SMOKE      = process.argv.includes('--smoke-test');
const RESET      = process.argv.includes('--reset-admin');

/* --------------------------------------------------------------------------
 * Directory skeleton  (must exist before anything else touches disk)
 * ----------------------------------------------------------------------- */
for (const d of [SRV, DATA, PUBLIC, LOGS, TMP, BK_SERVER, BK_CADDY, UPLOADS]) {
    try { fs.mkdirSync(d, { recursive: true }); } catch (e) {}
}
try { fs.chmodSync(DATA, 0o700); } catch (e) {}

/* --------------------------------------------------------------------------
 * ROLLBACK GUARD
 * Runs before any other logic so that a broken update can still recover.
 * update-pending.json is written by the Update handler just before restart.
 * Attempt 1 = the new code's first boot (allowed). Attempt 2 = it crashed
 * and systemd restarted us, so restore the backup and go back.
 * ----------------------------------------------------------------------- */
(function rollbackGuard() {
    if (SMOKE) return;
    let p;
    try { p = JSON.parse(fs.readFileSync(F.pending, 'utf8')); } catch (e) { return; }
    p.attempts = (p.attempts | 0) + 1;
    if (p.attempts <= 1) {
        try { fs.writeFileSync(F.pending, JSON.stringify(p)); } catch (e) {}
        return;
    }
    // Second boot with the marker still present -> the new file is broken.
    let detail = '';
    try {
        detail = execSync('journalctl -u ' + SERVICE + ' -n 60 --no-pager 2>/dev/null')
            .toString().slice(-6000);
    } catch (e) { detail = '(journal unavailable)'; }
    try { fs.copyFileSync(p.backup, SELF); } catch (e) {}
    try {
        fs.writeFileSync(F.report, JSON.stringify({
            ok: false,
            ts: Date.now(),
            what: p.what || 'server.js',
            message: 'The new ' + (p.what || 'server.js') +
                     ' started but crashed. Rolled back to ' + path.basename(p.backup) + '.',
            detail: detail
        }, null, 2));
    } catch (e) {}
    try { fs.unlinkSync(F.pending); } catch (e) {}
    try {
        spawn('sh', ['-c', 'sleep 1; systemctl restart ' + SERVICE],
              { detached: true, stdio: 'ignore' }).unref();
    } catch (e) {}
    process.exit(1);
})();

/* --------------------------------------------------------------------------
 * Small utilities
 * ----------------------------------------------------------------------- */
const now   = () => Date.now();
const b64u  = b => Buffer.from(b).toString('base64')
                    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64u= s => Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/'), 'base64');
const rnd   = n => crypto.randomBytes(n);
const rndTok= n => rnd(n || 24).toString('base64')
                    .replace(/[^a-zA-Z0-9]/g, '').slice(0, (n || 24) * 4 / 3 | 0);

function log(file, msg) {
    const line = '[' + new Date().toISOString() + '] ' + msg + '\n';
    try { fs.appendFileSync(file, line); } catch (e) {}
}
const blog = m => log(F.bootlog, m);

function readJSON(file, fallback) {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
    catch (e) { return fallback; }
}
function writeJSON(file, obj) {
    const tmp = file + '.' + process.pid + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
    fs.renameSync(tmp, file);
}
function sh(cmd, timeout) {
    try {
        return { ok: true, out: execSync(cmd, {
            timeout: timeout || 15000, stdio: ['ignore', 'pipe', 'pipe']
        }).toString() };
    } catch (e) {
        /* Keep stdout/stderr separate from the failure message: callers parse
         * `out` (e.g. "inactive" from systemctl) and must not see "Command
         * failed: ..." there when a binary is simply missing. */
        return {
            ok  : false,
            out : ((e.stdout || '') + '' + (e.stderr || '')).toString(),
            err : e.message
        };
    }
}
function humanBytes(n) {
    const u = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
    let i = 0; n = Number(n) || 0;
    while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
    return (i === 0 ? n : n.toFixed(1)) + ' ' + u[i];
}

/* --------------------------------------------------------------------------
 * Secret store  -  AES-256-GCM, machine bound.
 * Key = HKDF( random keyfile bytes  ||  /etc/machine-id  ||  hostname )
 * The keyfile lives at 0600 inside Server/data. Copying the encrypted blob to
 * another machine without the keyfile gets you nothing; no passphrase is ever
 * typed at boot.
 * ----------------------------------------------------------------------- */
function machineKey() {
    let seed;
    if (fs.existsSync(F.key)) {
        seed = fs.readFileSync(F.key);
    } else {
        seed = rnd(32);
        fs.writeFileSync(F.key, seed, { mode: 0o600 });
        try { fs.chmodSync(F.key, 0o600); } catch (e) {}
    }
    let mid = '';
    for (const p of ['/etc/machine-id', '/var/lib/dbus/machine-id']) {
        try { mid = fs.readFileSync(p, 'utf8').trim(); break; } catch (e) {}
    }
    return crypto.hkdfSync('sha256', seed,
        Buffer.from('nodeportal.v1'), Buffer.from(mid + '|' + os.hostname()), 32);
}
let KEY = null;
const getKey = () => (KEY || (KEY = Buffer.from(machineKey())));

function encrypt(obj) {
    const iv = rnd(12);
    const c  = crypto.createCipheriv('aes-256-gcm', getKey(), iv);
    const ct = Buffer.concat([c.update(JSON.stringify(obj), 'utf8'), c.final()]);
    return Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64');
}
function decrypt(blob) {
    const raw = Buffer.from(blob, 'base64');
    const d   = crypto.createDecipheriv('aes-256-gcm', getKey(), raw.subarray(0, 12));
    d.setAuthTag(raw.subarray(12, 28));
    return JSON.parse(Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString('utf8'));
}
function loadAdmin() {
    if (!fs.existsSync(F.admin)) return null;
    try { return decrypt(fs.readFileSync(F.admin, 'utf8')); }
    catch (e) { blog('admin.enc could not be decrypted: ' + e.message); return null; }
}
function saveAdmin(a) {
    fs.writeFileSync(F.admin, encrypt(a), { mode: 0o600 });
}

/* password hashing */
function hashPw(pw, salt) {
    salt = salt || rnd(16).toString('hex');
    const h = crypto.scryptSync(pw, salt, 64, { N: 16384, r: 8, p: 1 }).toString('hex');
    return { salt, hash: h };
}
function checkPw(pw, rec) {
    if (!rec) return false;
    const h = crypto.scryptSync(pw, rec.salt, 64, { N: 16384, r: 8, p: 1 }).toString('hex');
    return crypto.timingSafeEqual(Buffer.from(h), Buffer.from(rec.hash));
}

/* --------------------------------------------------------------------------
 * Settings
 * ----------------------------------------------------------------------- */
const defaultSettings = {
    siteName   : 'Node Portal',
    domain     : 'example.com',
    createdAt  : now()
};
let settings = Object.assign({}, defaultSettings, readJSON(F.settings, {}));
const saveSettings = () => writeJSON(F.settings, settings);
if (!fs.existsSync(F.settings)) saveSettings();

/* --------------------------------------------------------------------------
 * Base32 + TOTP (RFC 6238, SHA1, 6 digits, 30s step, +/-1 window)
 * ----------------------------------------------------------------------- */
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function b32encode(buf) {
    let bits = 0, val = 0, out = '';
    for (const byte of buf) {
        val = (val << 8) | byte; bits += 8;
        while (bits >= 5) { out += B32[(val >>> (bits - 5)) & 31]; bits -= 5; }
    }
    if (bits) out += B32[(val << (5 - bits)) & 31];
    return out;
}
function b32decode(str) {
    let bits = 0, val = 0; const out = [];
    for (const ch of String(str).toUpperCase().replace(/[=\s]/g, '')) {
        const i = B32.indexOf(ch);
        if (i < 0) continue;
        val = (val << 5) | i; bits += 5;
        if (bits >= 8) { out.push((val >>> (bits - 8)) & 255); bits -= 8; }
    }
    return Buffer.from(out);
}
function hotp(secretBuf, counter) {
    const buf = Buffer.alloc(8);
    buf.writeUInt32BE(Math.floor(counter / 4294967296), 0);
    buf.writeUInt32BE(counter >>> 0, 4);
    const h = crypto.createHmac('sha1', secretBuf).update(buf).digest();
    const o = h[19] & 15;
    const n = ((h[o] & 127) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3];
    return String(n % 1000000).padStart(6, '0');
}
function totpCheck(secretB32, code, window) {
    code = String(code || '').replace(/\D/g, '');
    if (code.length !== 6) return false;
    const key = b32decode(secretB32);
    const step = Math.floor(now() / 30000);
    const w = window === undefined ? 1 : window;
    for (let i = -w; i <= w; i++) {
        const c = hotp(key, step + i);
        if (crypto.timingSafeEqual(Buffer.from(c), Buffer.from(code))) return true;
    }
    return false;
}
function otpauthURI(user, secret, issuer) {
    return 'otpauth://totp/' + encodeURIComponent(issuer) + ':' + encodeURIComponent(user) +
           '?secret=' + secret + '&issuer=' + encodeURIComponent(issuer) +
           '&algorithm=SHA1&digits=6&period=30';
}

/* --------------------------------------------------------------------------
 * QR code generator  (byte mode, EC level M, versions 1-10)
 * Written from scratch so the setup page needs no external image or library.
 * ----------------------------------------------------------------------- */
const QR = (function () {
    /* GF(256) tables, primitive polynomial 0x11d */
    const EXP = new Uint8Array(512), LOG = new Uint8Array(256);
    (function () {
        let x = 1;
        for (let i = 0; i < 255; i++) {
            EXP[i] = x; LOG[x] = i;
            x <<= 1; if (x & 256) x ^= 0x11d;
        }
        for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
    })();
    const gmul = (a, b) => (a === 0 || b === 0) ? 0 : EXP[LOG[a] + LOG[b]];

    function rsPoly(deg) {
        let poly = [1];
        for (let i = 0; i < deg; i++) {
            const next = new Array(poly.length + 1).fill(0);
            for (let j = 0; j < poly.length; j++) {
                next[j]     ^= poly[j];                    // multiply by x
                next[j + 1] ^= gmul(poly[j], EXP[i]);      // multiply by alpha^i
            }
            poly = next;
        }
        return poly;
    }
    function rsEncode(data, ecLen) {
        const gen = rsPoly(ecLen);
        const res = new Array(ecLen).fill(0);
        for (const b of data) {
            const factor = b ^ res[0];
            res.shift(); res.push(0);
            for (let i = 0; i < ecLen; i++) res[i] ^= gmul(gen[i + 1] !== undefined ? gen[i + 1] : 0, factor);
        }
        return res;
    }

    /* per-version, EC level M: [totalCodewords, ecPerBlock, g1Blocks, g2Blocks] */
    const VER = {
        1 : [26 , 10, 1, 0], 2 : [44 , 16, 1, 0], 3 : [70 , 26, 1, 0],
        4 : [100, 18, 2, 0], 5 : [134, 24, 2, 0], 6 : [172, 16, 4, 0],
        7 : [196, 18, 4, 0], 8 : [242, 22, 2, 2], 9 : [292, 22, 3, 2],
        10: [346, 26, 4, 1]
    };
    const ALIGN = {
        1: [], 2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30], 6: [6, 34],
        7: [6, 22, 38], 8: [6, 24, 42], 9: [6, 26, 46], 10: [6, 28, 50]
    };

    function capacity(v) {
        const [total, ec, g1, g2] = VER[v];
        const dataCw = total - ec * (g1 + g2);
        const lenBits = v <= 9 ? 8 : 16;
        return Math.floor((dataCw * 8 - 4 - lenBits) / 8);
    }

    function buildData(bytes, v) {
        const [total, ec, g1, g2] = VER[v];
        const nBlocks = g1 + g2;
        const dataCw  = total - ec * nBlocks;
        const lenBits = v <= 9 ? 8 : 16;

        /* bit stream */
        const bits = [];
        const push = (val, n) => { for (let i = n - 1; i >= 0; i--) bits.push((val >>> i) & 1); };
        push(4, 4);                       // byte mode
        push(bytes.length, lenBits);
        for (const b of bytes) push(b, 8);
        for (let i = 0; i < 4 && bits.length < dataCw * 8; i++) bits.push(0);
        while (bits.length % 8) bits.push(0);
        const cw = [];
        for (let i = 0; i < bits.length; i += 8) {
            let b = 0;
            for (let j = 0; j < 8; j++) b = (b << 1) | bits[i + j];
            cw.push(b);
        }
        const PAD = [0xEC, 0x11];
        let pi = 0;
        while (cw.length < dataCw) cw.push(PAD[pi++ % 2]);

        /* split into blocks */
        const short = Math.floor(dataCw / nBlocks);
        const blocks = [], ecs = [];
        let off = 0;
        for (let i = 0; i < nBlocks; i++) {
            const len = i < g1 ? short : short + 1;
            const blk = cw.slice(off, off + len); off += len;
            blocks.push(blk);
            ecs.push(rsEncode(blk, ec));
        }
        /* interleave */
        const out = [];
        const maxLen = Math.max(...blocks.map(b => b.length));
        for (let i = 0; i < maxLen; i++)
            for (const b of blocks) if (i < b.length) out.push(b[i]);
        for (let i = 0; i < ec; i++)
            for (const e of ecs) out.push(e[i]);
        return out;
    }

    function newMatrix(size) {
        const m = [], r = [];
        for (let i = 0; i < size; i++) {
            m.push(new Int8Array(size).fill(-1));
            r.push(new Uint8Array(size));
        }
        return { m, reserved: r, size };
    }
    function place(g, x, y, val, reserve) {
        if (x < 0 || y < 0 || x >= g.size || y >= g.size) return;
        g.m[y][x] = val; if (reserve !== false) g.reserved[y][x] = 1;
    }
    function finder(g, cx, cy) {
        for (let dy = -1; dy <= 7; dy++)
            for (let dx = -1; dx <= 7; dx++) {
                const x = cx + dx, y = cy + dy;
                if (x < 0 || y < 0 || x >= g.size || y >= g.size) continue;
                const inner = dx >= 0 && dx <= 6 && dy >= 0 && dy <= 6;
                let v = 0;
                if (inner) {
                    const edge = dx === 0 || dx === 6 || dy === 0 || dy === 6;
                    const core = dx >= 2 && dx <= 4 && dy >= 2 && dy <= 4;
                    v = (edge || core) ? 1 : 0;
                }
                place(g, x, y, v);
            }
    }
    function alignPat(g, cx, cy) {
        for (let dy = -2; dy <= 2; dy++)
            for (let dx = -2; dx <= 2; dx++) {
                const d = Math.max(Math.abs(dx), Math.abs(dy));
                place(g, cx + dx, cy + dy, d === 1 ? 0 : 1);
            }
    }
    function bch15(fmt) {
        let d = fmt << 10;
        for (let i = 14; i >= 10; i--) if ((d >>> i) & 1) d ^= 0x537 << (i - 10);
        return ((fmt << 10) | d) ^ 0x5412;
    }
    function bch18(ver) {
        let d = ver << 12;
        for (let i = 17; i >= 12; i--) if ((d >>> i) & 1) d ^= 0x1F25 << (i - 12);
        return (ver << 12) | d;
    }
    const MASKS = [
        (r, c) => (r + c) % 2 === 0,
        (r, c) => r % 2 === 0,
        (r, c) => c % 3 === 0,
        (r, c) => (r + c) % 3 === 0,
        (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
        (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
        (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
        (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0
    ];

    function penalty(m, size) {
        let p = 0;
        /* rule 1: runs of 5+ */
        for (let i = 0; i < size; i++) {
            for (const dir of [0, 1]) {
                let run = 1, prev = -1;
                for (let j = 0; j < size; j++) {
                    const v = dir ? m[j][i] : m[i][j];
                    if (v === prev) { run++; if (run === 5) p += 3; else if (run > 5) p += 1; }
                    else { run = 1; prev = v; }
                }
            }
        }
        /* rule 2: 2x2 blocks */
        for (let y = 0; y < size - 1; y++)
            for (let x = 0; x < size - 1; x++) {
                const v = m[y][x];
                if (v === m[y][x + 1] && v === m[y + 1][x] && v === m[y + 1][x + 1]) p += 3;
            }
        /* rule 3: finder-like patterns */
        const pat1 = [1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 0];
        const pat2 = [0, 0, 0, 0, 1, 0, 1, 1, 1, 0, 1];
        const scan = arr => {
            for (let i = 0; i + 11 <= arr.length; i++) {
                let a = true, b = true;
                for (let j = 0; j < 11; j++) {
                    if (arr[i + j] !== pat1[j]) a = false;
                    if (arr[i + j] !== pat2[j]) b = false;
                }
                if (a) p += 40; if (b) p += 40;
            }
        };
        for (let i = 0; i < size; i++) {
            const row = [], col = [];
            for (let j = 0; j < size; j++) { row.push(m[i][j]); col.push(m[j][i]); }
            scan(row); scan(col);
        }
        /* rule 4: dark ratio */
        let dark = 0;
        for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) if (m[y][x]) dark++;
        const pct = dark * 100 / (size * size);
        p += Math.floor(Math.abs(pct - 50) / 5) * 10;
        return p;
    }

    function encode(text) {
        const bytes = Array.from(Buffer.from(text, 'utf8'));
        let v = 0;
        for (let i = 1; i <= 10; i++) if (capacity(i) >= bytes.length) { v = i; break; }
        if (!v) throw new Error('QR payload too long');

        const size = 17 + v * 4;
        const g = newMatrix(size);

        finder(g, 0, 0); finder(g, size - 7, 0); finder(g, 0, size - 7);
        for (let i = 8; i < size - 8; i++) {
            place(g, i, 6, i % 2 === 0 ? 1 : 0);
            place(g, 6, i, i % 2 === 0 ? 1 : 0);
        }
        const al = ALIGN[v];
        for (const cy of al) for (const cx of al) {
            const nearFinder =
                (cx <= 8 && cy <= 8) ||
                (cx >= size - 9 && cy <= 8) ||
                (cx <= 8 && cy >= size - 9);
            if (!nearFinder) alignPat(g, cx, cy);
        }
        place(g, 8, size - 8, 1);                       // dark module

        /* reserve format areas */
        for (let i = 0; i < 9; i++) {
            if (g.m[8][i] === -1) { g.m[8][i] = 0; g.reserved[8][i] = 1; }
            if (g.m[i][8] === -1) { g.m[i][8] = 0; g.reserved[i][8] = 1; }
        }
        for (let i = 0; i < 8; i++) {
            g.reserved[8][size - 1 - i] = 1; if (g.m[8][size - 1 - i] === -1) g.m[8][size - 1 - i] = 0;
            g.reserved[size - 1 - i][8] = 1; if (g.m[size - 1 - i][8] === -1) g.m[size - 1 - i][8] = 0;
        }
        if (v >= 7) {
            for (let i = 0; i < 18; i++) {
                const a = size - 11 + (i % 3), b = Math.floor(i / 3);
                g.reserved[b][a] = 1; g.m[b][a] = 0;
                g.reserved[a][b] = 1; g.m[a][b] = 0;
            }
        }

        /* data placement, zig-zag from bottom right */
        const data = buildData(bytes, v);
        const bitAt = i => (data[i >> 3] >>> (7 - (i & 7))) & 1;
        let bi = 0, up = true;
        for (let col = size - 1; col > 0; col -= 2) {
            if (col === 6) col = 5;
            for (let n = 0; n < size; n++) {
                const y = up ? size - 1 - n : n;
                for (const x of [col, col - 1]) {
                    if (g.reserved[y][x]) continue;
                    g.m[y][x] = bi < data.length * 8 ? bitAt(bi) : 0;
                    bi++;
                }
            }
            up = !up;
        }

        /* choose mask */
        let best = null, bestScore = Infinity, bestMask = 0;
        for (let mk = 0; mk < 8; mk++) {
            const cand = g.m.map(r => Array.from(r));
            for (let y = 0; y < size; y++)
                for (let x = 0; x < size; x++)
                    if (!g.reserved[y][x] && MASKS[mk](y, x)) cand[y][x] ^= 1;
            /* format bits for this mask, EC level M = 00 */
            const fmt = bch15((0 << 3) | mk);   // EC level M -> 0
            for (let i = 0; i < 15; i++) {
                const b = (fmt >>> i) & 1;      // LSB first
                if (i <= 5)       cand[i][8]      = b;
                else if (i === 6) cand[7][8]      = b;
                else if (i === 7) cand[8][8]      = b;
                else if (i === 8) cand[8][7]      = b;
                else              cand[8][14 - i] = b;
                if (i < 8)        cand[8][size - 1 - i]  = b;
                else              cand[size - 15 + i][8] = b;
            }
            cand[size - 8][8] = 1;              // dark module
            if (v >= 7) {
                const vi = bch18(v);
                for (let i = 0; i < 18; i++) {
                    const b = (vi >>> i) & 1;
                    const a = size - 11 + (i % 3), c = Math.floor(i / 3);
                    cand[c][a] = b;
                    cand[a][c] = b;
                }
            }
            const sc = penalty(cand, size);
            if (sc < bestScore) { bestScore = sc; best = cand; bestMask = mk; }
        }
        return best;
    }

    function svg(text, scale, quiet) {
        const m = encode(text);
        const s = scale || 5, q = quiet === undefined ? 4 : quiet;
        const size = m.length, dim = (size + q * 2) * s;
        let d = '';
        for (let y = 0; y < size; y++) {
            let x = 0;
            while (x < size) {
                if (m[y][x]) {
                    let w = 1;
                    while (x + w < size && m[y][x + w]) w++;
                    d += 'M' + ((x + q) * s) + ' ' + ((y + q) * s) + 'h' + (w * s) + 'v' + s + 'h' + (-w * s) + 'z';
                    x += w;
                } else x++;
            }
        }
        return '<svg xmlns="http://www.w3.org/2000/svg" width="' + dim + '" height="' + dim +
               '" viewBox="0 0 ' + dim + ' ' + dim + '" shape-rendering="crispEdges">' +
               '<rect width="' + dim + '" height="' + dim + '" fill="#ffffff"/>' +
               '<path d="' + d + '" fill="#000000"/></svg>';
    }
    return { encode, svg };
})();

/* --------------------------------------------------------------------------
 * Sessions
 * ----------------------------------------------------------------------- */
const SESSION_TTL = 30 * 24 * 3600 * 1000;
let sessions = readJSON(F.sessions, {});
function saveSessions() { try { writeJSON(F.sessions, sessions); } catch (e) {} }
function gcSessions() {
    let changed = false;
    for (const k in sessions) if (sessions[k].exp < now()) { delete sessions[k]; changed = true; }
    if (changed) saveSessions();
}
gcSessions();

function newSession(user, ip) {
    const sid = rnd(32).toString('hex');
    sessions[sid] = { user, ip, created: now(), exp: now() + SESSION_TTL, last: now() };
    saveSessions();
    return sid;
}
function getSession(req) {
    const c = parseCookies(req.headers.cookie || '');
    const s = c.npsid && sessions[c.npsid];
    if (!s) return null;
    if (s.exp < now()) { delete sessions[c.npsid]; saveSessions(); return null; }
    s.last = now();
    return { sid: c.npsid, data: s };
}
function parseCookies(str) {
    const out = {};
    for (const part of String(str).split(';')) {
        const i = part.indexOf('=');
        if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
    }
    return out;
}

/* login throttle */
const loginFails = new Map();
function throttled(ip) {
    const r = loginFails.get(ip);
    if (!r) return 0;
    if (now() - r.at > 15 * 60 * 1000) { loginFails.delete(ip); return 0; }
    return r.n >= 8 ? Math.ceil((r.at + 15 * 60 * 1000 - now()) / 1000) : 0;
}
function noteFail(ip) {
    const r = loginFails.get(ip) || { n: 0, at: now() };
    r.n++; r.at = now();
    loginFails.set(ip, r);
}

/* --------------------------------------------------------------------------
 * Hardware / network statistics
 * Sampled every 60s, 60 points retained (= one hour), persisted to disk so the
 * chart survives a restart.
 * ----------------------------------------------------------------------- */
const STAT_INTERVAL = 60000;
const STAT_POINTS   = 60;

let statHistory = readJSON(F.stats, { points: [] }).points || [];
if (!Array.isArray(statHistory)) statHistory = [];

function readProcFile(p) { try { return fs.readFileSync(p, 'utf8'); } catch (e) { return ''; } }

function cpuTotals() {
    const c = os.cpus();
    let idle = 0, total = 0;
    for (const cpu of c)
        for (const k in cpu.times) { total += cpu.times[k]; if (k === 'idle') idle += cpu.times[k]; }
    return { idle, total, cores: c.length, model: c[0] ? c[0].model : 'unknown',
             speed: c[0] ? c[0].speed : 0 };
}
function netTotals() {
    let rx = 0, tx = 0;
    const perIface = {};
    for (const line of readProcFile('/proc/net/dev').split('\n').slice(2)) {
        const m = line.trim().match(/^([^:]+):\s*(.*)$/);
        if (!m) continue;
        const name = m[1].trim();
        if (name === 'lo') continue;
        const f = m[2].trim().split(/\s+/).map(Number);
        rx += f[0] || 0; tx += f[8] || 0;
        perIface[name] = { rx: f[0] || 0, tx: f[8] || 0 };
    }
    return { rx, tx, perIface };
}
function diskTotals() {
    let read = 0, write = 0;
    for (const line of readProcFile('/proc/diskstats').split('\n')) {
        const f = line.trim().split(/\s+/);
        if (f.length < 14) continue;
        const name = f[2];
        /* only whole physical devices, skip partitions and virtual devices */
        if (/^(loop|ram|dm-|sr|zram)/.test(name)) continue;
        if (/\d$/.test(name) && /^(sd|vd|hd)/.test(name)) continue;
        if (/p\d+$/.test(name) && /^nvme/.test(name)) continue;
        read  += (Number(f[5]) || 0) * 512;
        write += (Number(f[9]) || 0) * 512;
    }
    return { read, write };
}
function memInfo() {
    const mi = {};
    for (const line of readProcFile('/proc/meminfo').split('\n')) {
        const m = line.match(/^(\w+):\s+(\d+)/);
        if (m) mi[m[1]] = Number(m[2]) * 1024;
    }
    const total = mi.MemTotal || os.totalmem();
    const avail = mi.MemAvailable !== undefined ? mi.MemAvailable : os.freemem();
    return {
        total, avail, used: total - avail,
        cached   : (mi.Cached || 0) + (mi.Buffers || 0),
        swapTotal: mi.SwapTotal || 0,
        swapUsed : (mi.SwapTotal || 0) - (mi.SwapFree || 0)
    };
}
function temperature() {
    let best = null;
    try {
        for (const d of fs.readdirSync('/sys/class/thermal')) {
            if (!/^thermal_zone/.test(d)) continue;
            const t = Number(readProcFile('/sys/class/thermal/' + d + '/temp').trim());
            if (!isNaN(t) && t > 0) {
                const c = t > 1000 ? t / 1000 : t;
                if (c > 0 && c < 150 && (best === null || c > best)) best = c;
            }
        }
    } catch (e) {}
    if (best === null) {
        try {
            for (const d of fs.readdirSync('/sys/class/hwmon')) {
                for (const f2 of fs.readdirSync('/sys/class/hwmon/' + d)) {
                    if (!/^temp\d+_input$/.test(f2)) continue;
                    const t = Number(readProcFile('/sys/class/hwmon/' + d + '/' + f2).trim()) / 1000;
                    if (t > 0 && t < 150 && (best === null || t > best)) best = t;
                }
            }
        } catch (e) {}
    }
    return best;
}
function diskUsage() {
    const out = [];
    const seen = new Set();
    for (const line of readProcFile('/proc/mounts').split('\n')) {
        const f = line.split(/\s+/);
        if (f.length < 3) continue;
        const [dev, mnt, type] = f;
        if (!/^\/dev\//.test(dev)) continue;
        if (/^(squashfs|iso9660|overlay)$/.test(type)) continue;
        if (seen.has(mnt)) continue;
        seen.add(mnt);
        try {
            const s = fs.statfsSync ? fs.statfsSync(mnt) : null;
            if (s) {
                const total = s.blocks * s.bsize;
                const free  = s.bavail * s.bsize;
                if (total > 0) out.push({ mount: mnt, dev, type, total, free, used: total - free });
            }
        } catch (e) {}
    }
    if (!out.length) {
        const r = sh("df -B1 -x tmpfs -x devtmpfs -x squashfs --output=source,target,fstype,size,avail 2>/dev/null | tail -n +2");
        if (r.ok) for (const line of r.out.trim().split('\n')) {
            const f = line.trim().split(/\s+/);
            if (f.length >= 5) {
                const total = Number(f[3]), free = Number(f[4]);
                if (total > 0) out.push({ mount: f[1], dev: f[0], type: f[2], total, free, used: total - free });
            }
        }
    }
    return out;
}

let lastCpu = cpuTotals(), lastNet = netTotals(), lastDisk = diskTotals(), lastAt = now();

function sample() {
    const c = cpuTotals(), n = netTotals(), d = diskTotals(), t = now();
    const dt = Math.max(1, (t - lastAt) / 1000);
    const dTotal = c.total - lastCpu.total, dIdle = c.idle - lastCpu.idle;
    const cpuPct = dTotal > 0 ? Math.max(0, Math.min(100, (1 - dIdle / dTotal) * 100)) : 0;
    const m = memInfo();

    const point = {
        t,
        cpu      : +cpuPct.toFixed(1),
        load1    : +os.loadavg()[0].toFixed(2),
        temp     : temperature(),
        memUsed  : m.used,
        memTotal : m.total,
        swapUsed : m.swapUsed,
        swapTotal: m.swapTotal,
        netRx    : Math.max(0, (n.rx - lastNet.rx) / dt),
        netTx    : Math.max(0, (n.tx - lastNet.tx) / dt),
        dskRd    : Math.max(0, (d.read  - lastDisk.read)  / dt),
        dskWr    : Math.max(0, (d.write - lastDisk.write) / dt)
    };
    lastCpu = c; lastNet = n; lastDisk = d; lastAt = t;

    statHistory.push(point);
    while (statHistory.length > STAT_POINTS) statHistory.shift();
    try { writeJSON(F.stats, { points: statHistory }); } catch (e) {}
    return point;
}

/* quick instantaneous read for the dashboard's "now" row */
function liveSnapshot(cb) {
    const c0 = cpuTotals(), n0 = netTotals(), d0 = diskTotals(), t0 = now();
    setTimeout(() => {
        const c1 = cpuTotals(), n1 = netTotals(), d1 = diskTotals();
        const dt = Math.max(0.001, (now() - t0) / 1000);
        const dT = c1.total - c0.total, dI = c1.idle - c0.idle;
        const m = memInfo();
        cb({
            cpu      : dT > 0 ? +Math.max(0, Math.min(100, (1 - dI / dT) * 100)).toFixed(1) : 0,
            cores    : c1.cores,
            cpuModel : c1.model,
            cpuSpeed : c1.speed,
            load     : os.loadavg().map(x => +x.toFixed(2)),
            temp     : temperature(),
            mem      : m,
            netRx    : Math.max(0, (n1.rx - n0.rx) / dt),
            netTx    : Math.max(0, (n1.tx - n0.tx) / dt),
            dskRd    : Math.max(0, (d1.read  - d0.read)  / dt),
            dskWr    : Math.max(0, (d1.write - d0.write) / dt),
            ifaces   : n1.perIface,
            disks    : diskUsage(),
            uptime   : os.uptime(),
            hostname : os.hostname(),
            platform : os.platform() + ' ' + os.release(),
            arch     : os.arch(),
            node     : process.version,
            procUptime: process.uptime(),
            procMem  : process.memoryUsage().rss,
            time     : now()
        });
    }, 400);
}

/* --------------------------------------------------------------------------
 * ZIP writer  (streaming, deflate, data descriptors, no external lib)
 * ----------------------------------------------------------------------- */
const CRC_TABLE = (function () {
    const t = new Int32Array(256);
    for (let i = 0; i < 256; i++) {
        let c = i;
        for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
        t[i] = c;
    }
    return t;
})();
function crc32(buf, seed) {
    let c = (seed === undefined ? 0 : seed) ^ -1;
    for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ -1) >>> 0;
}
function dosTime(d) {
    const t = ((d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() / 2)) & 0xFFFF;
    const dd = (((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()) & 0xFFFF;
    return { t, d: dd };
}

/* Walk a directory tree, returning [{abs, rel, size, mtime, dir}] */
function walkTree(root, base) {
    const out = [];
    const stack = [{ abs: root, rel: base || path.basename(root) }];
    while (stack.length) {
        const cur = stack.pop();
        let st;
        try { st = fs.lstatSync(cur.abs); } catch (e) { continue; }
        if (st.isSymbolicLink()) continue;
        if (st.isDirectory()) {
            out.push({ abs: cur.abs, rel: cur.rel, dir: true, mtime: st.mtime });
            let entries = [];
            try { entries = fs.readdirSync(cur.abs); } catch (e) {}
            for (const e of entries)
                stack.push({ abs: path.join(cur.abs, e), rel: cur.rel + '/' + e });
        } else if (st.isFile()) {
            out.push({ abs: cur.abs, rel: cur.rel, dir: false, size: st.size, mtime: st.mtime });
        }
    }
    return out;
}

/* Streams a zip of `entries` into the http response */
function streamZip(res, entries, zipName) {
    res.writeHead(200, {
        'Content-Type'       : 'application/zip',
        'Content-Disposition': 'attachment; filename="' + zipName.replace(/"/g, '') + '"',
        'Cache-Control'      : 'no-store'
    });
    const central = [];
    let offset = 0;
    const write = buf => new Promise(r => { offset += buf.length; res.write(buf) ? r() : res.once('drain', r); });

    (async function run() {
        for (const e of entries) {
            const name = e.dir ? e.rel.replace(/\/*$/, '') + '/' : e.rel;
            const nameBuf = Buffer.from(name, 'utf8');
            const dt = dosTime(e.mtime || new Date());
            const localOff = offset;

            const lh = Buffer.alloc(30);
            lh.writeUInt32LE(0x04034b50, 0);
            lh.writeUInt16LE(20, 4);
            lh.writeUInt16LE(0x0808, 6);              // data descriptor + utf8 name
            lh.writeUInt16LE(e.dir ? 0 : 8, 8);       // deflate for files
            lh.writeUInt16LE(dt.t, 10); lh.writeUInt16LE(dt.d, 12);
            lh.writeUInt32LE(0, 14); lh.writeUInt32LE(0, 18); lh.writeUInt32LE(0, 22);
            lh.writeUInt16LE(nameBuf.length, 26); lh.writeUInt16LE(0, 28);
            await write(Buffer.concat([lh, nameBuf]));

            let crc = 0, raw = 0, comp = 0;
            if (!e.dir) {
                await new Promise(resolve => {
                    const rs = fs.createReadStream(e.abs);
                    const df = zlib.createDeflateRaw({ level: 6 });
                    let running = -1;                       // running CRC state
                    rs.on('error', () => df.end());
                    rs.on('data', c => {
                        for (let i = 0; i < c.length; i++)
                            running = CRC_TABLE[(running ^ c[i]) & 0xFF] ^ (running >>> 8);
                        raw += c.length;
                    });
                    df.on('data', c => {
                        comp += c.length; offset += c.length;
                        if (!res.write(c)) {                // respect backpressure
                            df.pause();
                            res.once('drain', () => df.resume());
                        }
                    });
                    df.on('end', () => { crc = (running ^ -1) >>> 0; resolve(); });
                    df.on('error', () => { crc = (running ^ -1) >>> 0; resolve(); });
                    rs.pipe(df);
                });
            }
            const dd = Buffer.alloc(16);
            dd.writeUInt32LE(0x08074b50, 0);
            dd.writeUInt32LE(crc, 4);
            dd.writeUInt32LE(comp, 8);
            dd.writeUInt32LE(raw, 12);
            await write(dd);

            central.push({ name: nameBuf, crc, comp, raw, off: localOff, dt, dir: e.dir });
        }

        const cdStart = offset;
        for (const c of central) {
            const h = Buffer.alloc(46);
            h.writeUInt32LE(0x02014b50, 0);
            h.writeUInt16LE(0x031E, 4); h.writeUInt16LE(20, 6);
            h.writeUInt16LE(0x0808, 8); h.writeUInt16LE(c.dir ? 0 : 8, 10);
            h.writeUInt16LE(c.dt.t, 12); h.writeUInt16LE(c.dt.d, 14);
            h.writeUInt32LE(c.crc, 16); h.writeUInt32LE(c.comp, 20); h.writeUInt32LE(c.raw, 24);
            h.writeUInt16LE(c.name.length, 28);
            h.writeUInt16LE(0, 30); h.writeUInt16LE(0, 32);
            h.writeUInt16LE(0, 34); h.writeUInt16LE(0, 36);
            h.writeUInt32LE(c.dir ? 0x10 : 0, 38);
            h.writeUInt32LE(c.off, 42);
            await write(Buffer.concat([h, c.name]));
        }
        const eocd = Buffer.alloc(22);
        eocd.writeUInt32LE(0x06054b50, 0);
        eocd.writeUInt16LE(0, 4); eocd.writeUInt16LE(0, 6);
        eocd.writeUInt16LE(central.length, 8); eocd.writeUInt16LE(central.length, 10);
        eocd.writeUInt32LE(offset - cdStart, 12); eocd.writeUInt32LE(cdStart, 16);
        eocd.writeUInt16LE(0, 20);
        res.end(eocd);
    })().catch(() => { try { res.end(); } catch (e) {} });
}

/* --------------------------------------------------------------------------
 * WebSocket  (RFC 6455 server side, written from scratch)
 * Used by the terminal and by streamed command output.
 * ----------------------------------------------------------------------- */
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

function wsAccept(key) {
    return crypto.createHash('sha1').update(key + WS_GUID).digest('base64');
}

class WSConn {
    constructor(socket) {
        this.sock = socket;
        this.buf = Buffer.alloc(0);
        this.open = true;
        this.handlers = { message: [], close: [] };
        this.fragOp = 0;
        this.fragBuf = [];
        socket.on('data', d => this._feed(d));
        socket.on('close', () => this._closed());
        socket.on('error', () => this._closed());
        this.pinger = setInterval(() => { if (this.open) this._frame(0x9, Buffer.alloc(0)); }, 25000);
    }
    on(ev, fn) { if (this.handlers[ev]) this.handlers[ev].push(fn); return this; }
    _emit(ev, a) { for (const f of this.handlers[ev] || []) { try { f(a); } catch (e) {} } }
    _closed() {
        if (!this.open) return;
        this.open = false;
        clearInterval(this.pinger);
        this._emit('close');
    }
    _feed(d) {
        this.buf = Buffer.concat([this.buf, d]);
        for (;;) {
            if (this.buf.length < 2) return;
            const b0 = this.buf[0], b1 = this.buf[1];
            const fin = (b0 & 0x80) !== 0, op = b0 & 0x0f;
            const masked = (b1 & 0x80) !== 0;
            let len = b1 & 0x7f, off = 2;
            if (len === 126) {
                if (this.buf.length < 4) return;
                len = this.buf.readUInt16BE(2); off = 4;
            } else if (len === 127) {
                if (this.buf.length < 10) return;
                const hi = this.buf.readUInt32BE(2), lo = this.buf.readUInt32BE(6);
                len = hi * 4294967296 + lo; off = 10;
            }
            if (len > 64 * 1024 * 1024) { this.close(1009); return; }
            const need = off + (masked ? 4 : 0) + len;
            if (this.buf.length < need) return;
            let mask = null;
            if (masked) { mask = this.buf.subarray(off, off + 4); off += 4; }
            const payload = Buffer.from(this.buf.subarray(off, off + len));
            if (mask) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
            this.buf = this.buf.subarray(need);

            if (op === 0x8) { this.close(1000); return; }
            if (op === 0x9) { this._frame(0xA, payload); continue; }
            if (op === 0xA) continue;
            if (op === 0x0) {
                this.fragBuf.push(payload);
                if (fin) {
                    const full = Buffer.concat(this.fragBuf);
                    this.fragBuf = [];
                    this._deliver(this.fragOp, full);
                }
                continue;
            }
            if (!fin) { this.fragOp = op; this.fragBuf = [payload]; continue; }
            this._deliver(op, payload);
        }
    }
    _deliver(op, payload) {
        this._emit('message', op === 0x1 ? payload.toString('utf8') : payload);
    }
    _frame(op, payload) {
        if (!this.open || this.sock.destroyed) return;
        const len = payload.length;
        let head;
        if (len < 126) {
            head = Buffer.alloc(2);
            head[1] = len;
        } else if (len < 65536) {
            head = Buffer.alloc(4);
            head[1] = 126; head.writeUInt16BE(len, 2);
        } else {
            head = Buffer.alloc(10);
            head[1] = 127;
            head.writeUInt32BE(Math.floor(len / 4294967296), 2);
            head.writeUInt32BE(len >>> 0, 6);
        }
        head[0] = 0x80 | op;
        try { this.sock.write(Buffer.concat([head, payload])); } catch (e) {}
    }
    send(data) {
        if (Buffer.isBuffer(data)) this._frame(0x2, data);
        else this._frame(0x1, Buffer.from(String(data), 'utf8'));
    }
    json(obj) { this.send(JSON.stringify(obj)); }
    close(code) {
        if (!this.open) return;
        const b = Buffer.alloc(2); b.writeUInt16BE(code || 1000, 0);
        this._frame(0x8, b);
        this.open = false;
        clearInterval(this.pinger);
        try { this.sock.end(); } catch (e) {}
        this._emit('close');
    }
}

function wsHandshake(req, socket, head) {
    const key = req.headers['sec-websocket-key'];
    if (!key || (req.headers.upgrade || '').toLowerCase() !== 'websocket') {
        socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
        return null;
    }
    socket.write(
        'HTTP/1.1 101 Switching Protocols\r\n' +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        'Sec-WebSocket-Accept: ' + wsAccept(key) + '\r\n\r\n'
    );
    socket.setNoDelay(true);
    const c = new WSConn(socket);
    if (head && head.length) c._feed(head);
    return c;
}

/* --------------------------------------------------------------------------
 * PTY terminal.
 * node-pty is not available with zero dependencies, but util-linux `script`
 * allocates a real pty and proxies it over stdio, which gives a genuine
 * interactive bash (job control, colours, vim, htop, tab completion).
 * A fresh shell is started for every page load.
 * ----------------------------------------------------------------------- */
function startTerminal(ws) {
    let child;
    const shell = fs.existsSync('/bin/bash') ? '/bin/bash' : '/bin/sh';
    try {
        child = spawn('script',
            ['-q', '-f', '-c', shell + ' -l', '/dev/null'],
            {
                cwd: SRV,
                env: Object.assign({}, process.env, {
                    TERM: 'xterm-256color',
                    COLORTERM: 'truecolor',
                    LANG: process.env.LANG || 'C.UTF-8',
                    PS1: '\\[\\e[38;5;214m\\]\\u@\\h\\[\\e[0m\\]:\\[\\e[38;5;80m\\]\\w\\[\\e[0m\\]\\$ '
                }),
                stdio: ['pipe', 'pipe', 'pipe']
            });
    } catch (e) {
        ws.json({ type: 'error', message: 'Could not start a shell: ' + e.message });
        ws.close(1011);
        return;
    }

    const out = d => { if (ws.open) ws.send(d); };
    child.stdout.on('data', out);
    child.stderr.on('data', out);
    child.on('exit', code => {
        if (ws.open) {
            ws.send(Buffer.from('\r\n\x1b[38;5;244m[session ended, exit ' + code + ']\x1b[0m\r\n'));
            ws.close(1000);
        }
    });

    ws.on('message', msg => {
        if (typeof msg === 'string' && msg[0] === '{') {
            let m;
            try { m = JSON.parse(msg); } catch (e) { m = null; }
            if (m && m.type === 'resize') {
                /* the pty inherits our window size via stty inside the shell */
                try {
                    child.stdin.write('stty rows ' + (m.rows | 0) + ' cols ' + (m.cols | 0) + ' 2>/dev/null\n');
                } catch (e) {}
                return;
            }
            if (m && m.type === 'data') { try { child.stdin.write(m.data); } catch (e) {} return; }
        }
        try { child.stdin.write(msg); } catch (e) {}
    });
    ws.on('close', () => { try { child.kill('SIGHUP'); } catch (e) {} });
}

/* --------------------------------------------------------------------------
 * Streamed command runner (maintenance buttons)
 * ----------------------------------------------------------------------- */
const MAINTENANCE = {
    'apt-update'   : { label: 'Update packages',
                       cmd: 'export DEBIAN_FRONTEND=noninteractive; apt-get update && apt-get -y -o Dpkg::Options::=--force-confold upgrade' },
    'apt-autoremove':{ label: 'Remove unused packages', cmd: 'apt-get -y autoremove --purge' },
    'apt-clean'    : { label: 'Clear package cache', cmd: 'apt-get clean && apt-get autoclean' },
    'journal-clean': { label: 'Trim system logs', cmd: 'journalctl --vacuum-time=7d && journalctl --vacuum-size=200M' },
    'restart-node' : { label: 'Restart portal', cmd: 'sleep 1; systemctl restart ' + SERVICE, detach: true },
    'restart-caddy': { label: 'Restart Caddy', cmd: 'systemctl restart caddy && systemctl status caddy --no-pager -n 10' },
    'reload-caddy' : { label: 'Reload Caddy', cmd: 'systemctl reload caddy && echo "Caddy reloaded"' },
    'restart-os'   : { label: 'Reboot server', cmd: 'sleep 2; systemctl reboot', detach: true },
    'shutdown-os'  : { label: 'Shut down server', cmd: 'sleep 2; systemctl poweroff', detach: true },
    'disk-usage'   : { label: 'Show disk usage', cmd: 'df -h; echo; du -xh --max-depth=1 / 2>/dev/null | sort -rh | head -20' },
    'service-status':{ label: 'Service status',
                       cmd: 'systemctl status ' + SERVICE + ' --no-pager -n 15; echo; systemctl status caddy --no-pager -n 15' }
};

function runStreamed(ws, key) {
    const job = MAINTENANCE[key];
    if (!job) { ws.json({ type: 'end', code: 1, message: 'Unknown action' }); ws.close(); return; }
    ws.json({ type: 'start', label: job.label });
    if (job.detach) {
        ws.json({ type: 'out', data: job.label + ' requested. The connection will drop shortly.\n' });
        spawn('sh', ['-c', job.cmd], { detached: true, stdio: 'ignore' }).unref();
        ws.json({ type: 'end', code: 0 });
        setTimeout(() => ws.close(), 200);
        return;
    }
    const p = spawn('sh', ['-c', job.cmd], {
        env: Object.assign({}, process.env, { DEBIAN_FRONTEND: 'noninteractive' })
    });
    p.stdout.on('data', d => ws.json({ type: 'out', data: d.toString() }));
    p.stderr.on('data', d => ws.json({ type: 'out', data: d.toString() }));
    p.on('exit', c => { ws.json({ type: 'end', code: c }); setTimeout(() => ws.close(), 150); });
    p.on('error', e => { ws.json({ type: 'out', data: 'Failed to run: ' + e.message + '\n' });
                         ws.json({ type: 'end', code: 1 }); });
    ws.on('close', () => { try { p.kill('SIGTERM'); } catch (e) {} });
}

/* --------------------------------------------------------------------------
 * File helpers
 * ----------------------------------------------------------------------- */
const MIME = {
    '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',   '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8', '.txt': 'text/plain; charset=utf-8',
    '.md': 'text/markdown; charset=utf-8', '.xml': 'application/xml; charset=utf-8',
    '.csv': 'text/csv; charset=utf-8', '.yml': 'text/yaml; charset=utf-8',
    '.yaml': 'text/yaml; charset=utf-8', '.svg': 'image/svg+xml',
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
    '.gif': 'image/gif', '.webp': 'image/webp', '.avif': 'image/avif',
    '.ico': 'image/x-icon', '.bmp': 'image/bmp',
    '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.otf': 'font/otf',
    '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime',
    '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.flac': 'audio/flac',
    '.pdf': 'application/pdf', '.zip': 'application/zip', '.gz': 'application/gzip',
    '.tar': 'application/x-tar', '.wasm': 'application/wasm'
};
const mimeFor = p => MIME[path.extname(p).toLowerCase()] || 'application/octet-stream';

const TEXT_EXT = new Set(['.html','.htm','.css','.js','.mjs','.json','.txt','.md','.xml','.csv',
    '.yml','.yaml','.svg','.sh','.bash','.conf','.cfg','.ini','.env','.log','.sql','.py','.rb',
    '.php','.go','.rs','.c','.h','.cpp','.hpp','.java','.ts','.tsx','.jsx','.toml','.service',
    '.gitignore','.dockerfile','.caddyfile','.properties','.lock','.diff','.patch']);

function isTextFile(p, size) {
    if (size > 8 * 1024 * 1024) return false;
    const ext = path.extname(p).toLowerCase();
    if (TEXT_EXT.has(ext)) return true;
    const base = path.basename(p).toLowerCase();
    if (['caddyfile','dockerfile','makefile','readme','license','.bashrc','.profile','.env'].includes(base)) return true;
    if (ext === '') {
        try {
            const fd = fs.openSync(p, 'r');
            const buf = Buffer.alloc(Math.min(4096, size || 4096));
            const n = fs.readSync(fd, buf, 0, buf.length, 0);
            fs.closeSync(fd);
            for (let i = 0; i < n; i++) if (buf[i] === 0) return false;
            return true;
        } catch (e) { return false; }
    }
    return false;
}

/* Resolve a user supplied path. Absolute paths are allowed (full filesystem
 * access was requested) but traversal is normalised so the client can never
 * construct something the server did not intend. */
function resolvePath(p) {
    if (!p || typeof p !== 'string') return SRV;
    let r = p.startsWith('/') ? path.resolve(p) : path.resolve(SRV, p);
    return r;
}
function statSafe(p) { try { return fs.lstatSync(p); } catch (e) { return null; } }

function listDir(dir) {
    const st = statSafe(dir);
    if (!st || !st.isDirectory()) throw new Error('Not a directory: ' + dir);
    const names = fs.readdirSync(dir);
    const items = [];
    for (const name of names) {
        const abs = path.join(dir, name);
        const s = statSafe(abs);
        if (!s) continue;
        let linkTo = null, isDir = s.isDirectory();
        if (s.isSymbolicLink()) {
            try {
                linkTo = fs.readlinkSync(abs);
                const t = fs.statSync(abs);
                isDir = t.isDirectory();
            } catch (e) { isDir = false; }
        }
        items.push({
            name, dir: isDir,
            size: s.isFile() ? s.size : 0,
            mtime: s.mtimeMs,
            mode: '0' + (s.mode & 0o777).toString(8),
            link: linkTo,
            text: !isDir && isTextFile(abs, s.size),
            ext: path.extname(name).toLowerCase()
        });
    }
    items.sort((a, b) => (b.dir - a.dir) || a.name.localeCompare(b.name, undefined, { numeric: true }));
    const parts = [];
    let acc = '';
    for (const seg of dir.split('/')) {
        if (seg === '') { parts.push({ name: '/', path: '/' }); acc = ''; continue; }
        acc += '/' + seg;
        parts.push({ name: seg, path: acc });
    }
    return { path: dir, parent: path.dirname(dir), items, crumbs: parts,
             writable: !isProtected(dir) };
}

/* A short list of places where an accidental delete would brick the box.
 * Reads are always allowed; only destructive writes are refused here. */
const PROTECTED = ['/proc', '/sys', '/dev'];
function isProtected(p) {
    const r = path.resolve(p);
    if (r === '/') return true;
    return PROTECTED.some(x => r === x || r.startsWith(x + '/'));
}

function rmrf(p) {
    if (isProtected(p)) throw new Error('Refusing to delete a protected system path');
    fs.rmSync(p, { recursive: true, force: true });
}

/* --------------------------------------------------------------------------
 * Shares
 * ----------------------------------------------------------------------- */
let shares = readJSON(F.shares, {});
const saveShares = () => writeJSON(F.shares, shares);

function shareValid(s) {
    if (!s) return false;
    if (s.expires && s.expires < now()) return false;
    return true;
}
function gcShares() {
    let ch = false;
    for (const k in shares)
        if (shares[k].expires && shares[k].expires < now() - 7 * 86400000) { delete shares[k]; ch = true; }
    if (ch) saveShares();
}

/* --------------------------------------------------------------------------
 * Custom API endpoints
 * Stored in Server/data/apis.json. Code runs unsandboxed with full require().
 * ----------------------------------------------------------------------- */
let apis = readJSON(F.apis, {});
const saveApis = () => writeJSON(F.apis, apis);

const apiStore = {};            /* per endpoint scratch space, in memory */
function apiLog(ep, level, args) {
    const msg = args.map(a => {
        if (typeof a === 'string') return a;
        try { return JSON.stringify(a); } catch (e) { return String(a); }
    }).join(' ');
    ep.logs = ep.logs || [];
    ep.logs.push({ t: now(), level, msg: msg.slice(0, 4000) });
    while (ep.logs.length > 100) ep.logs.shift();
    log(F.apilog, '[' + ep.name + '] ' + level + ': ' + msg.slice(0, 1000));
}

function compileEndpoint(ep) {
    const src = '"use strict";\nreturn (async function handler(ctx){\n' + ep.code + '\n});';
    /* eslint-disable no-new-func */
    return new Function('require', 'module', '__dirname', '__filename', src)(
        require, module, SRV, SELF
    );
}

async function runEndpoint(id, ctx, trigger) {
    const ep = apis[id];
    if (!ep) return { ok: false, error: 'No such endpoint' };
    if (!ep.enabled) return { ok: false, error: 'Endpoint is turned off' };
    const started = now();
    ctx = ctx || {};
    ctx.log   = (...a) => apiLog(ep, 'log', a);
    ctx.error = (...a) => apiLog(ep, 'error', a);
    ctx.store = apiStore[id] || (apiStore[id] = {});
    ctx.trigger = trigger || 'manual';
    ctx.endpoint = { id, name: ep.name, path: ep.path };
    ctx.server = {
        dir: SRV, root: ROOT, publicDir: PUBLIC, dataDir: DATA,
        stats: () => statHistory.slice(),
        settings: () => Object.assign({}, settings),
        shares: () => Object.assign({}, shares),
        run: cmd => sh(cmd)
    };
    ctx.fs = fs; ctx.path = path; ctx.os = os; ctx.crypto = crypto;
    ctx.exec = sh;
    ctx.fetch = typeof fetch === 'function' ? fetch : undefined;

    try {
        const fn = compileEndpoint(ep);
        const result = await Promise.resolve(fn(ctx));
        ep.lastRun = started;
        ep.lastMs = now() - started;
        ep.lastOk = true;
        ep.lastError = null;
        saveApis();
        return { ok: true, result, ms: ep.lastMs };
    } catch (e) {
        ep.lastRun = started;
        ep.lastMs = now() - started;
        ep.lastOk = false;
        ep.lastError = (e && e.stack ? e.stack : String(e)).slice(0, 4000);
        apiLog(ep, 'error', [ep.lastError]);
        saveApis();
        return { ok: false, error: ep.lastError, ms: ep.lastMs };
    }
}

/* fire a portal event at every endpoint subscribed to it */
function emitEvent(name, payload) {
    for (const id in apis) {
        const ep = apis[id];
        if (!ep.enabled) continue;
        if (ep.events && ep.events.indexOf(name) >= 0)
            runEndpoint(id, { event: { name, payload } }, 'event:' + name);
    }
}

/* ---- cron -------------------------------------------------------------
 * Standard 5 field syntax: minute hour dayOfMonth month dayOfWeek
 * Supports *, lists, ranges and steps. Evaluated once a minute.
 * -------------------------------------------------------------------- */
function cronFieldMatch(field, value, min, max) {
    if (field === '*' || field === '?') return true;
    for (const part of field.split(',')) {
        let step = 1, range = part;
        const si = part.indexOf('/');
        if (si >= 0) { step = parseInt(part.slice(si + 1), 10) || 1; range = part.slice(0, si); }
        let lo, hi;
        if (range === '*') { lo = min; hi = max; }
        else if (range.indexOf('-') > 0) {
            const [a, b] = range.split('-');
            lo = parseInt(a, 10); hi = parseInt(b, 10);
        } else { lo = hi = parseInt(range, 10); }
        if (isNaN(lo) || isNaN(hi)) continue;
        for (let v = lo; v <= hi; v += step) if (v === value) return true;
    }
    return false;
}
function cronMatches(expr, d) {
    const f = String(expr).trim().split(/\s+/);
    if (f.length !== 5) return false;
    const dow = d.getDay();
    return cronFieldMatch(f[0], d.getMinutes(), 0, 59) &&
           cronFieldMatch(f[1], d.getHours(), 0, 23) &&
           cronFieldMatch(f[2], d.getDate(), 1, 31) &&
           cronFieldMatch(f[3], d.getMonth() + 1, 1, 12) &&
          (cronFieldMatch(f[4], dow, 0, 6) || (dow === 0 && cronFieldMatch(f[4], 7, 0, 7)));
}
function cronDescribe(expr) {
    const f = String(expr).trim().split(/\s+/);
    if (f.length !== 5) return 'invalid schedule';
    if (expr.trim() === '* * * * *') return 'every minute';
    const DAYS = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
    let s = '';
    if (f[0] !== '*' && f[1] !== '*') s = 'at ' + f[1].padStart(2, '0') + ':' + f[0].padStart(2, '0');
    else if (f[1] !== '*') s = 'hourly window ' + f[1];
    else if (f[0].startsWith('*/')) s = 'every ' + f[0].slice(2) + ' minutes';
    else if (f[0] !== '*') s = 'at minute ' + f[0] + ' of every hour';
    else s = 'every minute';
    if (f[4] !== '*') {
        const names = f[4].split(',').map(x => {
            const n = parseInt(x, 10);
            return isNaN(n) ? x : DAYS[n % 7];
        });
        s += ' on ' + names.join(', ');
    }
    if (f[2] !== '*') s += ' on day ' + f[2] + ' of the month';
    if (f[3] !== '*') s += ' in month ' + f[3];
    return s;
}
let lastCronMinute = -1;
function cronTick() {
    const d = new Date();
    const mark = d.getHours() * 60 + d.getMinutes();
    if (mark === lastCronMinute) return;
    lastCronMinute = mark;
    for (const id in apis) {
        const ep = apis[id];
        if (!ep.enabled || !ep.schedule || !ep.scheduleOn) continue;
        try {
            if (cronMatches(ep.schedule, d))
                runEndpoint(id, { scheduledAt: now() }, 'schedule');
        } catch (e) {}
    }
}

/* --------------------------------------------------------------------------
 * Backups  (rolling, newest first, 10 kept)
 * ----------------------------------------------------------------------- */
function makeBackup(dir, srcFile, prefix) {
    if (!fs.existsSync(srcFile)) return null;
    const name = prefix + '-' + new Date().toISOString().replace(/[:.]/g, '-') + '.bak';
    const dest = path.join(dir, name);
    fs.copyFileSync(srcFile, dest);
    const all = fs.readdirSync(dir)
        .filter(f => f.startsWith(prefix + '-'))
        .sort().reverse();
    for (const old of all.slice(10)) { try { fs.unlinkSync(path.join(dir, old)); } catch (e) {} }
    return dest;
}
function listBackups(dir, prefix) {
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir)
        .filter(f => f.startsWith(prefix + '-'))
        .sort().reverse()
        .slice(0, 10)
        .map(f => {
            const st = statSafe(path.join(dir, f));
            return { name: f, size: st ? st.size : 0, mtime: st ? st.mtimeMs : 0 };
        });
}

function restartSelf() {
    if (process.env.INVOCATION_ID || underSystemd()) {
        spawn('sh', ['-c', 'sleep 1; systemctl restart ' + SERVICE],
              { detached: true, stdio: 'ignore' }).unref();
    } else {
        /* No systemd here, so re-exec ourselves. The child waits a moment so
         * this process can close the listening socket first, otherwise the new
         * one dies on EADDRINUSE. */
        spawn('sh', ['-c', 'sleep 2; exec "' + process.execPath + '" "' + SELF + '" --foreground'],
              { detached: true, stdio: 'ignore', cwd: ROOT }).unref();
        setTimeout(() => { try { server.close(); } catch (e) {} process.exit(0); }, 300);
    }
}
function underSystemd() {
    const r = sh('systemctl is-active ' + SERVICE + ' 2>/dev/null');
    return r.out.trim() === 'active';
}

/* --------------------------------------------------------------------------
 * server.js update  (syntax check -> smoke test -> backup -> swap -> restart)
 * ----------------------------------------------------------------------- */
function applyServerUpdate(source, cb) {
    const tmpFile = path.join(TMP, 'candidate-' + now() + '.js');
    try { fs.writeFileSync(tmpFile, source); }
    catch (e) { return cb({ ok: false, stage: 'write', message: e.message }); }

    /* 1. syntax */
    const chk = spawnSync(process.execPath, ['--check', tmpFile], { encoding: 'utf8', timeout: 20000 });
    if (chk.status !== 0) {
        try { fs.unlinkSync(tmpFile); } catch (e) {}
        return cb({ ok: false, stage: 'syntax',
                    message: 'The new server.js has a syntax error. Nothing was changed.',
                    detail: (chk.stderr || '').toString().slice(0, 4000) });
    }

    /* 2. smoke test: boot it on a throwaway port and make sure it survives */
    const smoke = spawnSync(process.execPath, [tmpFile, '--smoke-test'], {
        encoding: 'utf8', timeout: 25000,
        env: Object.assign({}, process.env, { NP_SMOKE_PORT: '0' }),
        cwd: ROOT
    });
    if (smoke.status !== 0) {
        try { fs.unlinkSync(tmpFile); } catch (e) {}
        return cb({ ok: false, stage: 'smoke',
                    message: 'The new server.js failed to start. Nothing was changed.',
                    detail: ((smoke.stderr || '') + (smoke.stdout || '')).toString().slice(0, 4000) });
    }

    /* 3. backup + swap */
    let backup;
    try {
        backup = makeBackup(BK_SERVER, SELF, 'server');
        fs.copyFileSync(tmpFile, SELF);
        fs.chmodSync(SELF, 0o755);
        fs.unlinkSync(tmpFile);
    } catch (e) {
        return cb({ ok: false, stage: 'swap', message: 'Could not write server.js: ' + e.message });
    }

    /* 4. arm the rollback guard, then restart */
    try {
        writeJSON(F.pending, { backup, what: 'server.js', at: now(), attempts: 0 });
    } catch (e) {}
    cb({ ok: true, backup: backup ? path.basename(backup) : null });
    setTimeout(restartSelf, 400);
}

/* --------------------------------------------------------------------------
 * Caddy
 * ----------------------------------------------------------------------- */
const DEFAULT_CADDYFILE = ({ domain }) => `# Caddyfile - managed from the portal's Caddy tab.
#
# Replace ${domain} with your real domain and point its DNS at this server.
# Caddy fetches and renews a Let's Encrypt certificate automatically.

${domain} {
    encode zstd gzip

    reverse_proxy 127.0.0.1:${PORT} {
        header_up Host {host}
        header_up X-Real-IP {remote_host}
        header_up X-Forwarded-For {remote_host}
        header_up X-Forwarded-Proto {scheme}
    }

    log {
        output file /var/log/caddy/access.log {
            roll_size 10MiB
            roll_keep 5
        }
    }
}

# www redirect
www.${domain} {
    redir https://${domain}{uri} permanent
}
`;

function caddyStatus() {
    const active  = sh('systemctl is-active caddy 2>/dev/null').out.trim();
    const enabled = sh('systemctl is-enabled caddy 2>/dev/null').out.trim();
    const vr      = sh('caddy version 2>/dev/null');
    const ver     = vr.ok ? (vr.out.trim().split('\n')[0] || '') : '';
    const installed = !!ver || fs.existsSync('/usr/bin/caddy') || fs.existsSync('/usr/local/bin/caddy');
    let uptime = '';
    const p = sh("systemctl show caddy --property=ActiveEnterTimestamp --value 2>/dev/null").out.trim();
    if (p) uptime = p;
    return { installed, active, enabled, version: ver, since: uptime,
             configPath: CADDYFILE, exists: fs.existsSync(CADDYFILE) };
}
function nodeServiceStatus() {
    return {
        active : sh('systemctl is-active ' + SERVICE + ' 2>/dev/null').out.trim(),
        enabled: sh('systemctl is-enabled ' + SERVICE + ' 2>/dev/null').out.trim(),
        since  : sh("systemctl show " + SERVICE + " --property=ActiveEnterTimestamp --value 2>/dev/null").out.trim(),
        pid    : process.pid,
        node   : process.version
    };
}

function applyCaddyfile(text, cb) {
    const tmpFile = path.join(TMP, 'Caddyfile.candidate');
    try { fs.writeFileSync(tmpFile, text); }
    catch (e) { return cb({ ok: false, stage: 'write', message: e.message }); }

    const val = spawnSync('caddy', ['validate', '--config', tmpFile, '--adapter', 'caddyfile'],
                          { encoding: 'utf8', timeout: 20000 });
    if (val.error && val.error.code === 'ENOENT')
        return cb({ ok: false, stage: 'missing', message: 'Caddy is not installed yet.' });
    if (val.status !== 0)
        return cb({ ok: false, stage: 'validate',
                    message: 'The Caddyfile did not validate. Nothing was changed.',
                    detail: ((val.stderr || '') + (val.stdout || '')).slice(0, 4000) });

    const backup = makeBackup(BK_CADDY, CADDYFILE, 'Caddyfile');
    try {
        fs.mkdirSync(path.dirname(CADDYFILE), { recursive: true });
        fs.copyFileSync(tmpFile, CADDYFILE);
    } catch (e) {
        return cb({ ok: false, stage: 'swap', message: 'Could not write the Caddyfile: ' + e.message });
    }

    const reload = sh('systemctl reload caddy 2>&1 || systemctl restart caddy 2>&1', 30000);
    const nowActive = sh('systemctl is-active caddy').out.trim();
    if (nowActive !== 'active') {
        if (backup) {                       /* auto rollback */
            try { fs.copyFileSync(backup, CADDYFILE); } catch (e) {}
            sh('systemctl restart caddy', 30000);
        }
        return cb({ ok: false, stage: 'reload',
                    message: 'Caddy refused to start with that config, so the previous Caddyfile was restored.',
                    detail: (reload.out || reload.err || '').slice(0, 4000) });
    }
    cb({ ok: true, backup: backup ? path.basename(backup) : null, detail: (reload.out || '').slice(0, 2000) });
}

/* --------------------------------------------------------------------------
 * First run installation:  systemd unit for this server + Caddy from apt
 * ----------------------------------------------------------------------- */
function writeSystemdUnit() {
    const unit = `[Unit]
Description=Node Portal (single file admin server)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=root
WorkingDirectory=${ROOT}
ExecStart=${process.execPath} ${SELF}
Restart=always
RestartSec=2
StandardOutput=journal
StandardError=journal
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
`;
    const target = '/etc/systemd/system/' + SERVICE + '.service';
    let changed = true;
    try { changed = fs.readFileSync(target, 'utf8') !== unit; } catch (e) {}
    if (changed) {
        fs.writeFileSync(target, unit);
        sh('systemctl daemon-reload');
        blog('systemd unit written to ' + target);
    }
    sh('systemctl enable ' + SERVICE + ' 2>&1');
    return target;
}

function installCaddy(cb) {
    if (caddyStatus().installed) {
        sh('systemctl enable caddy 2>&1');
        return cb && cb(true);
    }
    blog('Installing Caddy from the official apt repository...');
    const script = [
        'set -e',
        'export DEBIAN_FRONTEND=noninteractive',
        'apt-get update -qq',
        'apt-get install -y -qq debian-keyring debian-archive-keyring apt-transport-https curl gnupg',
        'curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/gpg.key ' +
            '| gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg',
        'curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt ' +
            '| tee /etc/apt/sources.list.d/caddy-stable.list >/dev/null',
        'apt-get update -qq',
        'apt-get install -y -qq caddy',
        'systemctl enable caddy'
    ].join('\n');

    const p = spawn('bash', ['-c', script], {
        env: Object.assign({}, process.env, { DEBIAN_FRONTEND: 'noninteractive' })
    });
    let out = '';
    p.stdout.on('data', d => { out += d; });
    p.stderr.on('data', d => { out += d; });
    p.on('exit', code => {
        blog('Caddy install exited ' + code + '\n' + out.slice(-4000));
        if (code === 0) {
            try { fs.mkdirSync('/var/log/caddy', { recursive: true }); } catch (e) {}
            if (!fs.existsSync(CADDYFILE)) {
                try {
                    fs.mkdirSync(path.dirname(CADDYFILE), { recursive: true });
                    fs.writeFileSync(CADDYFILE, DEFAULT_CADDYFILE({ domain: settings.domain }));
                } catch (e) {}
            }
            sh('systemctl enable --now caddy 2>&1');
        }
        cb && cb(code === 0);
    });
}

function seedPublic() {
    const idx = path.join(PUBLIC, 'index.html');
    if (fs.existsSync(idx)) return;
    fs.writeFileSync(idx, `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>It works</title>
<style>
    :root { color-scheme: dark; }
    body { margin:0; min-height:100vh; display:grid; place-items:center;
           background:#10131a; color:#d7dce5;
           font:16px/1.6 ui-monospace,SFMono-Regular,Menlo,monospace; }
    main { max-width:34rem; padding:2rem; }
    h1 { font-size:1.4rem; margin:0 0 .75rem; color:#e8a33d; letter-spacing:-.01em; }
    p { margin:0 0 .75rem; color:#79839a; }
    code { color:#4ec9d4; }
</style>
</head>
<body>
<main>
    <h1>Your site is live</h1>
    <p>This page is <code>Server/public/index.html</code>. Anything you drop into
       <code>Server/public</code> is served from the matching URL.</p>
    <p>Manage it from <code>/admin</code>.</p>
</main>
</body>
</html>
`);
    fs.writeFileSync(path.join(PUBLIC, '404.html'), `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Not found</title>
<style>:root{color-scheme:dark}body{margin:0;min-height:100vh;display:grid;place-items:center;
background:#10131a;color:#79839a;font:16px/1.6 ui-monospace,Menlo,monospace}
h1{color:#e8a33d;font-size:1.4rem;margin:0 0 .5rem}</style></head>
<body><main style="text-align:center"><h1>404</h1><p>No such page.</p></main></body></html>
`);
}

function bootstrap() {
    seedPublic();
    if (!fs.existsSync(CADDYFILE)) {
        try {
            fs.mkdirSync(path.dirname(CADDYFILE), { recursive: true });
            fs.writeFileSync(CADDYFILE, DEFAULT_CADDYFILE({ domain: settings.domain }));
        } catch (e) {}
    }
    if (process.getuid && process.getuid() !== 0) {
        blog('Not running as root - skipping systemd and Caddy installation.');
        return;
    }
    try { writeSystemdUnit(); } catch (e) { blog('systemd unit failed: ' + e.message); }
    if (!fs.existsSync(F.installed)) {
        installCaddy(ok => {
            try { fs.writeFileSync(F.installed, JSON.stringify({ at: now(), caddy: ok }, null, 2)); } catch (e) {}
        });
    } else {
        sh('systemctl enable caddy 2>/dev/null');
    }
}

/* --------------------------------------------------------------------------
 * HTTP plumbing
 * ----------------------------------------------------------------------- */
const SEC_HEADERS = {
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'X-Frame-Options': 'SAMEORIGIN'
};
function send(res, code, type, body, extra) {
    const h = Object.assign({ 'Content-Type': type }, SEC_HEADERS, extra || {});
    if (!h['Content-Length'] && !h['Transfer-Encoding'] && body !== undefined)
        h['Content-Length'] = Buffer.byteLength(body);
    res.writeHead(code, h);
    res.end(body);
}
const sendJSON = (res, code, obj, extra) =>
    send(res, code, 'application/json; charset=utf-8', JSON.stringify(obj), 
         Object.assign({ 'Cache-Control': 'no-store' }, extra || {}));
const sendHTML = (res, code, html, extra) =>
    send(res, code, 'text/html; charset=utf-8', html,
         Object.assign({ 'Cache-Control': 'no-store' }, extra || {}));
const sendText = (res, code, t) => send(res, code, 'text/plain; charset=utf-8', t);

function clientIP(req) {
    const xf = req.headers['x-forwarded-for'];
    if (xf) return String(xf).split(',')[0].trim();
    return (req.socket.remoteAddress || '').replace(/^::ffff:/, '');
}
function readBody(req, limit) {
    return new Promise((resolve, reject) => {
        const max = limit || 32 * 1024 * 1024;
        const chunks = []; let size = 0;
        req.on('data', c => {
            size += c.length;
            if (size > max) { reject(new Error('Body too large')); req.destroy(); return; }
            chunks.push(c);
        });
        req.on('end', () => resolve(Buffer.concat(chunks)));
        req.on('error', reject);
    });
}
async function readJSONBody(req, limit) {
    const b = await readBody(req, limit);
    if (!b.length) return {};
    try { return JSON.parse(b.toString('utf8')); }
    catch (e) { throw new Error('Invalid JSON body'); }
}
function escapeHTML(s) {
    return String(s).replace(/[&<>"']/g, c =>
        ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function cookieHeader(sid, maxAge) {
    return 'npsid=' + sid + '; Path=/; HttpOnly; SameSite=Lax; Max-Age=' + maxAge;
}

/* pending TOTP secrets during first time setup, keyed by a browser nonce */
const setupPending = new Map();

/* --------------------------------------------------------------------------
 * Static file serving with range support
 * ----------------------------------------------------------------------- */
function serveFile(req, res, abs, opts) {
    opts = opts || {};
    const st = statSafe(abs);
    if (!st || !st.isFile()) return false;
    const type = opts.type || mimeFor(abs);
    const etag = '"' + st.size.toString(16) + '-' + Math.floor(st.mtimeMs).toString(16) + '"';
    const headers = Object.assign({
        'Content-Type': type,
        'Last-Modified': new Date(st.mtime).toUTCString(),
        'ETag': etag,
        'Accept-Ranges': 'bytes',
        'Cache-Control': opts.cache || 'no-cache'
    }, SEC_HEADERS);
    if (opts.download)
        headers['Content-Disposition'] = 'attachment; filename="' +
            path.basename(abs).replace(/["\\]/g, '') + '"';

    if (req.headers['if-none-match'] === etag) { res.writeHead(304, headers); return res.end(), true; }

    const range = req.headers.range;
    if (range) {
        const m = /^bytes=(\d*)-(\d*)$/.exec(range);
        if (m) {
            let start = m[1] === '' ? st.size - Number(m[2]) : Number(m[1]);
            let end   = m[2] === '' || m[1] === '' ? st.size - 1 : Number(m[2]);
            start = Math.max(0, start); end = Math.min(st.size - 1, end);
            if (start > end) {
                res.writeHead(416, Object.assign({ 'Content-Range': 'bytes */' + st.size }, headers));
                return res.end(), true;
            }
            headers['Content-Range'] = 'bytes ' + start + '-' + end + '/' + st.size;
            headers['Content-Length'] = end - start + 1;
            res.writeHead(206, headers);
            fs.createReadStream(abs, { start, end }).pipe(res);
            return true;
        }
    }
    headers['Content-Length'] = st.size;
    res.writeHead(200, headers);
    if (req.method === 'HEAD') { res.end(); return true; }
    fs.createReadStream(abs).pipe(res);
    return true;
}

/* --------------------------------------------------------------------------
 * public/  served github-pages style
 * ----------------------------------------------------------------------- */
function servePublic(req, res, pathname) {
    let rel = decodeURIComponent(pathname);
    if (rel.indexOf('\0') >= 0) return sendText(res, 400, 'Bad path');
    const abs = path.resolve(PUBLIC, '.' + (rel.startsWith('/') ? rel : '/' + rel));
    if (abs !== PUBLIC && !abs.startsWith(PUBLIC + path.sep))
        return sendText(res, 403, 'Forbidden');

    const st = statSafe(abs);
    if (st && st.isDirectory()) {
        if (!rel.endsWith('/')) {
            res.writeHead(301, { Location: rel + '/' });
            return res.end();
        }
        for (const idx of ['index.html', 'index.htm']) {
            const c = path.join(abs, idx);
            if (statSafe(c)) return serveFile(req, res, c);
        }
        return notFoundPublic(req, res);
    }
    if (st && st.isFile()) return serveFile(req, res, abs);

    /* extensionless pretty urls: /about -> /about.html */
    if (!path.extname(abs)) {
        const alt = abs + '.html';
        if (statSafe(alt)) return serveFile(req, res, alt);
    }
    return notFoundPublic(req, res);
}
function notFoundPublic(req, res) {
    const custom = path.join(PUBLIC, '404.html');
    if (statSafe(custom)) {
        const body = fs.readFileSync(custom);
        return send(res, 404, 'text/html; charset=utf-8', body);
    }
    return sendText(res, 404, 'Not found');
}

/* --------------------------------------------------------------------------
 * Share links
 * ----------------------------------------------------------------------- */
function shareLanding(req, res, token, rest, pathname) {
    const s = shares[token];
    if (!shareValid(s)) return sendHTML(res, 404, sharePage('Link unavailable',
        '<p>This link has expired or was revoked.</p>'));

    s.hits = (s.hits || 0) + 1;
    s.lastHit = now();
    saveShares();
    emitEvent('share.accessed', { token, path: s.path, mode: s.mode, ip: clientIP(req) });

    const base = path.resolve(s.path);
    const st = statSafe(base);
    if (!st) return sendHTML(res, 404, sharePage('Gone', '<p>The shared item no longer exists.</p>'));

    const sub = rest ? decodeURIComponent(rest) : '';
    const target = sub ? path.resolve(base, '.' + (sub.startsWith('/') ? sub : '/' + sub)) : base;
    if (target !== base && !target.startsWith(base + path.sep))
        return sendText(res, 403, 'Forbidden');

    const url = new URL(req.url, 'http://x');
    const action = url.searchParams.get('a');
    const tst = statSafe(target);
    if (!tst) return sendHTML(res, 404, sharePage('Gone', '<p>Not found.</p>'));

    /* zip download of a folder */
    if (action === 'zip' && tst.isDirectory())
        return streamZip(res, walkTree(target, path.basename(target) || 'share'),
                         (path.basename(target) || 'share') + '.zip');

    if (req.method === 'POST' && action === 'save') {
        if (s.mode !== 'edit')
            return sendJSON(res, 403, { ok: false, error: 'This link is read only' });
        return readJSONBody(req, 64 * 1024 * 1024).then(b => {
            if (!tst.isFile()) return sendJSON(res, 400, { ok: false, error: 'Not a file' });
            fs.writeFileSync(target, String(b.content === undefined ? '' : b.content), 'utf8');
            emitEvent('share.edited', { token, path: target });
            sendJSON(res, 200, { ok: true, savedAt: now() });
        }).catch(e => sendJSON(res, 400, { ok: false, error: e.message }));
    }

    if (req.method === 'POST' && action === 'upload') {
        if (s.mode !== 'edit')
            return sendJSON(res, 403, { ok: false, error: 'This link is read only' });
        const nameHdr = req.headers['x-np-name'];
        if (!nameHdr) return sendJSON(res, 400, { ok: false, error: 'Missing file name' });
        const name = path.basename(Buffer.from(String(nameHdr), 'base64').toString('utf8'));
        const dest = path.join(tst.isDirectory() ? target : path.dirname(target), name);
        const ws = fs.createWriteStream(dest);
        req.pipe(ws);
        ws.on('close', () => sendJSON(res, 200, { ok: true, name }));
        ws.on('error', e => sendJSON(res, 500, { ok: false, error: e.message }));
        return;
    }

    /* a file */
    if (tst.isFile()) {
        if (s.mode === 'read' || action === 'dl')
            return serveFile(req, res, target, { download: action !== 'view' });
        /* edit mode -> minimal editor */
        const text = isTextFile(target, tst.size);
        if (!text)
            return serveFile(req, res, target, { download: true });
        const content = fs.readFileSync(target, 'utf8');
        return sendHTML(res, 200, shareEditor(token, rest || '', path.basename(target), content, s));
    }

    /* a folder */
    const listing = listDir(target);
    const rows = listing.items.map(it => {
        const href = '/s/' + token + (rest || '') + '/' + encodeURIComponent(it.name);
        if (it.dir)
            return '<li class="d"><a href="' + href + '">' + escapeHTML(it.name) + '/</a>' +
                   '<span>folder</span><a class="z" href="' + href + '?a=zip">zip</a></li>';
        return '<li><a href="' + href + (s.mode === 'edit' && it.text ? '' : '?a=dl') + '">' +
               escapeHTML(it.name) + '</a><span>' + humanBytes(it.size) + '</span>' +
               '<a class="z" href="' + href + '?a=dl">download</a></li>';
    }).join('');
    const up = rest ? '<a class="up" href="/s/' + token + rest.replace(/\/[^/]*$/, '') + '">&larr; up</a>' : '';
    return sendHTML(res, 200, sharePage(path.basename(target) || 'Shared folder',
        up +
        '<p class="meta">' + listing.items.length + ' items' +
        (s.mode === 'edit' ? ' &middot; you can edit files here' : ' &middot; read only') +
        (s.expires ? ' &middot; expires ' + new Date(s.expires).toLocaleString() : '') + '</p>' +
        '<p><a class="btn" href="/s/' + token + (rest || '') + '?a=zip">Download all as zip</a>' +
        (s.mode === 'edit' ? '<label class="btn up-btn">Upload files<input type="file" id="up" multiple hidden></label>' : '') +
        '</p>' +
        '<ul class="ls">' + rows + '</ul>' +
        (s.mode === 'edit' ? shareUploadScript(token, rest || '') : '')));
}

function sharePage(title, body) {
    return '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
        '<meta name="viewport" content="width=device-width,initial-scale=1">' +
        '<title>' + escapeHTML(title) + '</title><style>' + SHARE_CSS + '</style></head>' +
        '<body><main><h1>' + escapeHTML(title) + '</h1>' + body + '</main></body></html>';
}
function shareUploadScript(token, rest) {
    return '<script>' +
      'var inp=document.getElementById("up");' +
      'inp.onchange=async function(){' +
      'for(var i=0;i<inp.files.length;i++){var f=inp.files[i];' +
      'await fetch("/s/' + token + rest + '?a=upload",{method:"POST",' +
      'headers:{"X-Np-Name":btoa(unescape(encodeURIComponent(f.name)))},body:f});}' +
      'location.reload();};' +
      '</script>';
}
function shareEditor(token, rest, name, content, s) {
    return '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
        '<meta name="viewport" content="width=device-width,initial-scale=1">' +
        '<title>' + escapeHTML(name) + '</title><style>' + SHARE_CSS + SHARE_EDIT_CSS + '</style></head>' +
        '<body><main class="ed"><header><h1>' + escapeHTML(name) + '</h1>' +
        '<div><span id="st">Editing</span>' +
        '<button id="save">Save changes</button></div></header>' +
        '<textarea id="t" spellcheck="false">' + escapeHTML(content) + '</textarea>' +
        '<p class="meta">Shared link' + (s.expires ? ' &middot; expires ' +
            escapeHTML(new Date(s.expires).toLocaleString()) : '') + '</p></main><script>' +
        'var t=document.getElementById("t"),st=document.getElementById("st");' +
        't.addEventListener("keydown",function(e){if(e.key==="Tab"){e.preventDefault();' +
        'var s=t.selectionStart,en=t.selectionEnd;t.value=t.value.slice(0,s)+"    "+t.value.slice(en);' +
        't.selectionStart=t.selectionEnd=s+4;}});' +
        'document.getElementById("save").onclick=async function(){st.textContent="Saving...";' +
        'var r=await fetch("/s/' + token + rest + '?a=save",{method:"POST",' +
        'headers:{"Content-Type":"application/json"},body:JSON.stringify({content:t.value})});' +
        'var j=await r.json();st.textContent=j.ok?"Saved "+new Date().toLocaleTimeString():("Failed: "+j.error);};' +
        '</script></body></html>';
}
const SHARE_CSS = `
:root{color-scheme:dark}
*{box-sizing:border-box}
body{margin:0;background:#10131a;color:#d7dce5;
 font:15px/1.55 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
main{max-width:60rem;margin:0 auto;padding:2.5rem 1.25rem}
h1{font-size:1.25rem;margin:0 0 .35rem;color:#e8a33d;letter-spacing:-.01em;word-break:break-all}
.meta{color:#79839a;font-size:.82rem;margin:.2rem 0 1.25rem}
a{color:#4ec9d4;text-decoration:none}
a:hover{text-decoration:underline}
.up{display:inline-block;margin-bottom:.6rem;color:#79839a}
.btn{display:inline-block;background:#1d2330;border:1px solid #2b3446;color:#d7dce5;
 padding:.5rem .9rem;border-radius:6px;margin:0 .5rem .5rem 0;cursor:pointer;font:inherit}
.btn:hover{border-color:#e8a33d;color:#e8a33d;text-decoration:none}
ul.ls{list-style:none;padding:0;margin:1rem 0 0;border-top:1px solid #1f2634}
ul.ls li{display:flex;align-items:center;gap:.75rem;padding:.5rem .25rem;
 border-bottom:1px solid #1f2634}
ul.ls li a:first-child{flex:1;word-break:break-all}
ul.ls li span{color:#5d6879;font-size:.78rem;min-width:5rem;text-align:right}
ul.ls li a.z{color:#79839a;font-size:.78rem}
ul.ls li.d a:first-child{color:#e8a33d}
p{margin:.4rem 0}
`;
const SHARE_EDIT_CSS = `
main.ed{max-width:min(96rem,100%);display:flex;flex-direction:column;height:100vh;padding:1rem 1.25rem}
main.ed header{display:flex;justify-content:space-between;align-items:center;gap:1rem;flex-wrap:wrap}
main.ed header div{display:flex;align-items:center;gap:.75rem}
#st{color:#79839a;font-size:.8rem}
button{background:#e8a33d;border:0;color:#10131a;font:600 .85rem/1 ui-monospace,monospace;
 padding:.6rem 1rem;border-radius:6px;cursor:pointer}
button:hover{background:#f0b055}
textarea{flex:1;width:100%;margin:.85rem 0 0;background:#0c0f15;color:#d7dce5;
 border:1px solid #232b3a;border-radius:8px;padding:1rem;resize:none;
 font:13px/1.6 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;tab-size:4}
textarea:focus{outline:2px solid #e8a33d;outline-offset:-1px}
`;

/* --------------------------------------------------------------------------
 * Admin API
 * ----------------------------------------------------------------------- */
function requireAuth(req, res) {
    const s = getSession(req);
    if (!s) { sendJSON(res, 401, { ok: false, error: 'Not signed in', auth: false }); return null; }
    return s;
}
function requireCSRF(req, res) {
    if (req.method === 'GET' || req.method === 'HEAD') return true;
    if (req.headers['x-np'] !== '1') {
        sendJSON(res, 403, { ok: false, error: 'Missing request header' });
        return false;
    }
    return true;
}

async function adminAuthRoutes(req, res, sub) {
    const ip = clientIP(req);

    if (sub === '/status') {
        const admin = loadAdmin();
        const s = getSession(req);
        return sendJSON(res, 200, {
            mode: !admin ? 'setup' : (s ? 'ok' : 'login'),
            user: s ? s.data.user : null,
            siteName: settings.siteName
        });
    }

    if (sub === '/setup/begin' && req.method === 'POST') {
        if (loadAdmin()) return sendJSON(res, 409, { ok: false, error: 'An admin already exists' });
        const nonce  = rnd(16).toString('hex');
        const secret = b32encode(rnd(20));
        setupPending.set(nonce, { secret, at: now() });
        for (const [k, v] of setupPending) if (now() - v.at > 30 * 60 * 1000) setupPending.delete(k);
        const uri = otpauthURI('admin', secret, settings.siteName);
        let qr = '';
        try { qr = QR.svg(uri, 5, 3); } catch (e) { qr = ''; }
        return sendJSON(res, 200, { ok: true, nonce, secret, uri, qr });
    }

    if (sub === '/setup/complete' && req.method === 'POST') {
        if (loadAdmin()) return sendJSON(res, 409, { ok: false, error: 'An admin already exists' });
        const b = await readJSONBody(req);
        const pend = setupPending.get(b.nonce);
        if (!pend) return sendJSON(res, 400, { ok: false, error: 'Setup expired. Reload the page and start again.' });
        const user = String(b.username || '').trim();
        const pass = String(b.password || '');
        if (!/^[A-Za-z0-9._@-]{3,64}$/.test(user))
            return sendJSON(res, 400, { ok: false, error: 'Username must be 3-64 characters: letters, digits, . _ - @' });
        if (pass.length < 10)
            return sendJSON(res, 400, { ok: false, error: 'Use a password of at least 10 characters' });
        if (!totpCheck(pend.secret, b.code))
            return sendJSON(res, 400, { ok: false, error: 'That 6 digit code did not match. Check your authenticator and try the next one.' });

        const codes = [];
        for (let i = 0; i < 10; i++)
            codes.push(rnd(5).toString('hex').match(/.{1,5}/g).join('-'));
        const admin = {
            user,
            pw        : hashPw(pass),
            totp      : pend.secret,
            backup    : codes.map(c => crypto.createHash('sha256').update(c).digest('hex')),
            createdAt : now()
        };
        saveAdmin(admin);
        setupPending.delete(b.nonce);
        const sid = newSession(user, ip);
        emitEvent('admin.created', { user });
        return sendJSON(res, 200, { ok: true, backupCodes: codes },
                        { 'Set-Cookie': cookieHeader(sid, SESSION_TTL / 1000) });
    }

    if (sub === '/login' && req.method === 'POST') {
        const wait = throttled(ip);
        if (wait) return sendJSON(res, 429, { ok: false,
            error: 'Too many failed attempts. Try again in ' + Math.ceil(wait / 60) + ' minutes.' });
        const admin = loadAdmin();
        if (!admin) return sendJSON(res, 400, { ok: false, error: 'No admin account exists yet' });
        const b = await readJSONBody(req);
        const okUser = String(b.username || '') === admin.user;
        let okPw = false;
        try { okPw = checkPw(String(b.password || ''), admin.pw); } catch (e) { okPw = false; }
        const code = String(b.code || '').replace(/[^A-Za-z0-9-]/g, '');

        let okCode = false, usedBackup = false;
        if (okUser && okPw) {
            if (totpCheck(admin.totp, code)) okCode = true;
            else {
                const h = crypto.createHash('sha256').update(code.toLowerCase()).digest('hex');
                const i = (admin.backup || []).indexOf(h);
                if (i >= 0) { okCode = true; usedBackup = true; admin.backup.splice(i, 1); saveAdmin(admin); }
            }
        }
        if (!(okUser && okPw && okCode)) {
            noteFail(ip);
            emitEvent('login.failed', { ip, username: String(b.username || '') });
            return sendJSON(res, 401, { ok: false, error: 'Those details did not match.' });
        }
        loginFails.delete(ip);
        const sid = newSession(admin.user, ip);
        emitEvent('login.success', { ip, user: admin.user, usedBackup });
        return sendJSON(res, 200, {
            ok: true, usedBackup,
            backupRemaining: (admin.backup || []).length
        }, { 'Set-Cookie': cookieHeader(sid, SESSION_TTL / 1000) });
    }

    if (sub === '/logout') {
        const s = getSession(req);
        if (s) { delete sessions[s.sid]; saveSessions(); }
        return sendJSON(res, 200, { ok: true }, { 'Set-Cookie': cookieHeader('', 0) });
    }
    return sendJSON(res, 404, { ok: false, error: 'Unknown auth route' });
}

async function adminApiRoutes(req, res, sub, url) {
    const s = requireAuth(req, res);
    if (!s) return;
    if (!requireCSRF(req, res)) return;
    const q = url.searchParams;
    const P = () => resolvePath(q.get('path') || SRV);

    /* ---- overview -------------------------------------------------- */
    if (sub === '/overview') {
        return liveSnapshot(live => {
            let report = null;
            try {
                if (fs.existsSync(F.report)) {
                    report = readJSON(F.report, null);
                    fs.unlinkSync(F.report);
                }
            } catch (e) {}
            sendJSON(res, 200, {
                ok: true, live,
                history: statHistory,
                caddy: caddyStatus(),
                service: nodeServiceStatus(),
                settings,
                updateReport: report,
                serverDir: SRV, root: ROOT, self: SELF,
                shares: Object.keys(shares).length,
                endpoints: Object.keys(apis).length,
                maintenance: Object.keys(MAINTENANCE).map(k => ({ key: k, label: MAINTENANCE[k].label }))
            });
        });
    }
    if (sub === '/history') return sendJSON(res, 200, { ok: true, history: statHistory });

    /* ---- server.js source + update --------------------------------- */
    if (sub === '/source')
        return sendJSON(res, 200, {
            ok: true, source: fs.readFileSync(SELF, 'utf8'), path: SELF,
            backups: listBackups(BK_SERVER, 'server')
        });

    if (sub === '/source/update' && req.method === 'POST') {
        const b = await readJSONBody(req, 32 * 1024 * 1024);
        if (typeof b.source !== 'string' || b.source.length < 50)
            return sendJSON(res, 400, { ok: false, error: 'That does not look like a server file' });
        return applyServerUpdate(b.source, r => sendJSON(res, r.ok ? 200 : 400, r));
    }

    if (sub === '/backups') {
        const what = q.get('what') === 'caddy' ? 'caddy' : 'server';
        return sendJSON(res, 200, { ok: true,
            backups: listBackups(what === 'caddy' ? BK_CADDY : BK_SERVER,
                                 what === 'caddy' ? 'Caddyfile' : 'server') });
    }
    if (sub === '/backups/read') {
        const what = q.get('what') === 'caddy' ? 'caddy' : 'server';
        const dir  = what === 'caddy' ? BK_CADDY : BK_SERVER;
        const f2   = path.join(dir, path.basename(q.get('name') || ''));
        if (!f2.startsWith(dir) || !statSafe(f2))
            return sendJSON(res, 404, { ok: false, error: 'No such backup' });
        return sendJSON(res, 200, { ok: true, content: fs.readFileSync(f2, 'utf8') });
    }

    /* ---- caddy ------------------------------------------------------ */
    if (sub === '/caddy') {
        let cfg = '';
        try { cfg = fs.readFileSync(CADDYFILE, 'utf8'); }
        catch (e) { cfg = DEFAULT_CADDYFILE({ domain: settings.domain }); }
        return sendJSON(res, 200, {
            ok: true, config: cfg, status: caddyStatus(), service: nodeServiceStatus(),
            backups: listBackups(BK_CADDY, 'Caddyfile'),
            recentLog: sh('journalctl -u caddy -n 40 --no-pager 2>/dev/null').out.slice(-8000)
        });
    }
    if (sub === '/caddy/save' && req.method === 'POST') {
        const b = await readJSONBody(req);
        return applyCaddyfile(String(b.config || ''), r => sendJSON(res, r.ok ? 200 : 400, r));
    }
    if (sub === '/caddy/install' && req.method === 'POST') {
        installCaddy(() => {});
        return sendJSON(res, 200, { ok: true, message: 'Installing Caddy. Watch the Caddy tab for status.' });
    }

    /* ---- files ------------------------------------------------------ */
    if (sub === '/files/list') {
        try { return sendJSON(res, 200, Object.assign({ ok: true }, listDir(P()))); }
        catch (e) { return sendJSON(res, 400, { ok: false, error: e.message }); }
    }
    if (sub === '/files/read') {
        const p = P(), st = statSafe(p);
        if (!st || !st.isFile()) return sendJSON(res, 404, { ok: false, error: 'Not a file' });
        if (st.size > 8 * 1024 * 1024) return sendJSON(res, 413, { ok: false, error: 'File is too large to edit here' });
        return sendJSON(res, 200, { ok: true, content: fs.readFileSync(p, 'utf8'),
                                    size: st.size, mtime: st.mtimeMs, path: p });
    }
    if (sub === '/files/write' && req.method === 'POST') {
        const b = await readJSONBody(req, 64 * 1024 * 1024);
        const p = resolvePath(b.path);
        if (isProtected(p)) return sendJSON(res, 403, { ok: false, error: 'That path is protected' });
        try {
            fs.mkdirSync(path.dirname(p), { recursive: true });
            fs.writeFileSync(p, String(b.content === undefined ? '' : b.content), 'utf8');
            return sendJSON(res, 200, { ok: true, savedAt: now() });
        } catch (e) { return sendJSON(res, 500, { ok: false, error: e.message }); }
    }
    if (sub === '/files/mkdir' && req.method === 'POST') {
        const b = await readJSONBody(req);
        const p = path.join(resolvePath(b.path), path.basename(String(b.name || '')));
        try { fs.mkdirSync(p, { recursive: true }); return sendJSON(res, 200, { ok: true, path: p }); }
        catch (e) { return sendJSON(res, 500, { ok: false, error: e.message }); }
    }
    if (sub === '/files/newfile' && req.method === 'POST') {
        const b = await readJSONBody(req);
        const p = path.join(resolvePath(b.path), path.basename(String(b.name || 'untitled.txt')));
        if (statSafe(p)) return sendJSON(res, 409, { ok: false, error: 'Something with that name already exists' });
        try { fs.writeFileSync(p, ''); return sendJSON(res, 200, { ok: true, path: p }); }
        catch (e) { return sendJSON(res, 500, { ok: false, error: e.message }); }
    }
    if (sub === '/files/rename' && req.method === 'POST') {
        const b = await readJSONBody(req);
        const from = resolvePath(b.path);
        const to   = path.join(path.dirname(from), path.basename(String(b.name || '')));
        if (isProtected(from)) return sendJSON(res, 403, { ok: false, error: 'That path is protected' });
        try { fs.renameSync(from, to); return sendJSON(res, 200, { ok: true, path: to }); }
        catch (e) { return sendJSON(res, 500, { ok: false, error: e.message }); }
    }
    if (sub === '/files/move' && req.method === 'POST') {
        const b = await readJSONBody(req);
        const dest = resolvePath(b.dest);
        const done = [], failed = [];
        for (const raw of (b.paths || [])) {
            const from = resolvePath(raw);
            const to = path.join(dest, path.basename(from));
            try { fs.renameSync(from, to); done.push(to); }
            catch (e) { failed.push({ path: from, error: e.message }); }
        }
        return sendJSON(res, 200, { ok: !failed.length, moved: done.length, failed });
    }
    if (sub === '/files/delete' && req.method === 'POST') {
        const b = await readJSONBody(req);
        const failed = [];
        let n = 0;
        for (const raw of (b.paths || [])) {
            try { rmrf(resolvePath(raw)); n++; }
            catch (e) { failed.push({ path: raw, error: e.message }); }
        }
        return sendJSON(res, 200, { ok: !failed.length, deleted: n, failed });
    }
    if (sub === '/files/chmod' && req.method === 'POST') {
        const b = await readJSONBody(req);
        try {
            fs.chmodSync(resolvePath(b.path), parseInt(String(b.mode), 8));
            return sendJSON(res, 200, { ok: true });
        } catch (e) { return sendJSON(res, 500, { ok: false, error: e.message }); }
    }
    if (sub === '/files/upload' && req.method === 'POST') {
        const hdr = req.headers['x-np-path'];
        if (!hdr) return sendJSON(res, 400, { ok: false, error: 'Missing destination header' });
        let rel;
        try { rel = Buffer.from(String(hdr), 'base64').toString('utf8'); }
        catch (e) { return sendJSON(res, 400, { ok: false, error: 'Bad destination header' }); }
        const dir = resolvePath(req.headers['x-np-dir']
            ? Buffer.from(String(req.headers['x-np-dir']), 'base64').toString('utf8') : SRV);
        const dest = path.resolve(dir, './' + rel.replace(/^\/+/, ''));
        if (isProtected(dest)) return sendJSON(res, 403, { ok: false, error: 'That path is protected' });
        try { fs.mkdirSync(path.dirname(dest), { recursive: true }); }
        catch (e) { return sendJSON(res, 500, { ok: false, error: e.message }); }
        const ws = fs.createWriteStream(dest);
        req.pipe(ws);
        ws.on('close', () => sendJSON(res, 200, { ok: true, path: dest }));
        ws.on('error', e => sendJSON(res, 500, { ok: false, error: e.message }));
        return;
    }
    if (sub === '/files/download') {
        const p = P(), st = statSafe(p);
        if (!st) return sendJSON(res, 404, { ok: false, error: 'Not found' });
        if (st.isDirectory())
            return streamZip(res, walkTree(p, path.basename(p) || 'root'),
                             (path.basename(p) || 'root') + '.zip');
        return serveFile(req, res, p, { download: true });
    }
    if (sub === '/files/raw') {
        const p = P();
        if (!serveFile(req, res, p, { cache: 'no-store' }))
            return sendJSON(res, 404, { ok: false, error: 'Not found' });
        return;
    }
    if (sub === '/files/zip') {
        let list = [];
        try { list = JSON.parse(Buffer.from(q.get('paths') || '', 'base64').toString('utf8')); }
        catch (e) { list = []; }
        if (!list.length) {
            const p = P();
            return streamZip(res, walkTree(p, path.basename(p) || 'root'),
                             (path.basename(p) || 'root') + '.zip');
        }
        let entries = [];
        for (const raw of list) {
            const abs = resolvePath(raw);
            const st = statSafe(abs);
            if (!st) continue;
            if (st.isDirectory()) entries = entries.concat(walkTree(abs, path.basename(abs)));
            else entries.push({ abs, rel: path.basename(abs), dir: false, size: st.size, mtime: st.mtime });
        }
        return streamZip(res, entries, 'selection-' + new Date().toISOString().slice(0, 10) + '.zip');
    }

    /* ---- shares ------------------------------------------------------ */
    if (sub === '/shares') {
        gcShares();
        const list = Object.keys(shares).map(t => {
            const sh2 = shares[t];
            const st = statSafe(sh2.path);
            return Object.assign({ token: t, exists: !!st, isDir: st ? st.isDirectory() : false,
                                   expired: !shareValid(sh2) }, sh2);
        }).sort((a, b) => b.created - a.created);
        return sendJSON(res, 200, { ok: true, shares: list });
    }
    if (sub === '/shares/create' && req.method === 'POST') {
        const b = await readJSONBody(req);
        const p = resolvePath(b.path);
        if (!statSafe(p)) return sendJSON(res, 404, { ok: false, error: 'That path does not exist' });
        const token = rndTok(22);
        shares[token] = {
            path    : p,
            label   : String(b.label || path.basename(p) || p).slice(0, 120),
            mode    : b.mode === 'edit' ? 'edit' : 'read',
            created : now(),
            expires : b.expiresIn ? now() + Number(b.expiresIn) * 1000 : null,
            hits    : 0,
            by      : s.data.user
        };
        saveShares();
        return sendJSON(res, 200, { ok: true, token, share: shares[token] });
    }
    if (sub === '/shares/update' && req.method === 'POST') {
        const b = await readJSONBody(req);
        const sh2 = shares[b.token];
        if (!sh2) return sendJSON(res, 404, { ok: false, error: 'No such share' });
        if (b.mode) sh2.mode = b.mode === 'edit' ? 'edit' : 'read';
        if (b.label !== undefined) sh2.label = String(b.label).slice(0, 120);
        if (b.expiresIn !== undefined)
            sh2.expires = b.expiresIn ? now() + Number(b.expiresIn) * 1000 : null;
        saveShares();
        return sendJSON(res, 200, { ok: true, share: sh2 });
    }
    if (sub === '/shares/delete' && req.method === 'POST') {
        const b = await readJSONBody(req);
        for (const t of (b.tokens || [b.token])) delete shares[t];
        saveShares();
        return sendJSON(res, 200, { ok: true });
    }

    /* ---- custom endpoints -------------------------------------------- */
    if (sub === '/endpoints') {
        const list = Object.keys(apis).map(id => Object.assign({ id }, apis[id],
            { scheduleText: apis[id].schedule ? cronDescribe(apis[id].schedule) : '' }));
        list.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
        return sendJSON(res, 200, { ok: true, endpoints: list,
            events: ['login.success','login.failed','admin.created','share.accessed',
                     'share.edited','server.start','endpoint.called'] });
    }
    if (sub === '/endpoints/save' && req.method === 'POST') {
        const b = await readJSONBody(req, 8 * 1024 * 1024);
        const id = b.id || rndTok(10);
        let epPath = String(b.path || '').trim();
        if (!epPath.startsWith('/')) epPath = '/' + epPath;
        epPath = '/api' + epPath.replace(/^\/api(?=\/|$)/, '');
        epPath = epPath.replace(/\/+$/, '') || '/api';
        if (!/^\/api(\/[A-Za-z0-9._:-]+)*$/.test(epPath))
            return sendJSON(res, 400, { ok: false, error: 'Use a path like /api/my-endpoint' });
        for (const other in apis)
            if (other !== id && apis[other].path === epPath)
                return sendJSON(res, 409, { ok: false, error: 'Another endpoint already uses ' + epPath });

        /* compile check before saving */
        const draft = {
            name    : String(b.name || 'Untitled').slice(0, 80),
            path    : epPath,
            methods : Array.isArray(b.methods) && b.methods.length ? b.methods : ['GET'],
            enabled : b.enabled !== false,
            code    : String(b.code || ''),
            schedule: String(b.schedule || '').trim(),
            scheduleOn: !!b.scheduleOn,
            events  : Array.isArray(b.events) ? b.events : [],
            public  : !!b.public,
            logs    : (apis[id] && apis[id].logs) || [],
            created : (apis[id] && apis[id].created) || now(),
            updated : now()
        };
        if (draft.scheduleOn && cronDescribe(draft.schedule) === 'invalid schedule')
            return sendJSON(res, 400, { ok: false, error: 'That schedule is not a valid 5 field cron expression' });
        try { compileEndpoint(draft); }
        catch (e) { return sendJSON(res, 400, { ok: false, stage: 'syntax',
            error: 'The endpoint code has a syntax error: ' + e.message }); }

        apis[id] = draft;
        saveApis();
        return sendJSON(res, 200, { ok: true, id, endpoint: Object.assign({ id }, draft) });
    }
    if (sub === '/endpoints/delete' && req.method === 'POST') {
        const b = await readJSONBody(req);
        delete apis[b.id]; delete apiStore[b.id];
        saveApis();
        return sendJSON(res, 200, { ok: true });
    }
    if (sub === '/endpoints/run' && req.method === 'POST') {
        const b = await readJSONBody(req);
        const r = await runEndpoint(b.id, { manual: true, body: b.payload || {} }, 'manual');
        return sendJSON(res, 200, Object.assign({ endpointLogs: (apis[b.id] || {}).logs || [] }, r));
    }
    if (sub === '/endpoints/logs') {
        const ep = apis[q.get('id')];
        if (!ep) return sendJSON(res, 404, { ok: false, error: 'No such endpoint' });
        return sendJSON(res, 200, { ok: true, logs: ep.logs || [] });
    }

    /* ---- settings ---------------------------------------------------- */
    if (sub === '/settings/save' && req.method === 'POST') {
        const b = await readJSONBody(req);
        if (b.siteName) settings.siteName = String(b.siteName).slice(0, 60);
        if (b.domain)   settings.domain   = String(b.domain).slice(0, 200).trim();
        saveSettings();
        return sendJSON(res, 200, { ok: true, settings });
    }
    if (sub === '/logs') {
        const which = q.get('which') || 'portal';
        const unit  = which === 'caddy' ? 'caddy' : SERVICE;
        return sendJSON(res, 200, { ok: true,
            text: sh('journalctl -u ' + unit + ' -n 300 --no-pager 2>/dev/null').out.slice(-40000) });
    }

    return sendJSON(res, 404, { ok: false, error: 'Unknown admin route: ' + sub });
}

/* --------------------------------------------------------------------------
 * Custom /api/* dispatch
 * ----------------------------------------------------------------------- */
async function dispatchCustomApi(req, res, pathname, url) {
    let match = null;
    for (const id in apis) {
        const ep = apis[id];
        if (ep.path === pathname) { match = { id, ep }; break; }
    }
    if (!match) return false;
    const { id, ep } = match;
    if (!ep.enabled) { sendJSON(res, 503, { error: 'This endpoint is turned off' }); return true; }
    const methods = ep.methods || ['GET'];
    if (methods.indexOf('ANY') < 0 && methods.indexOf(req.method) < 0) {
        sendJSON(res, 405, { error: 'Method not allowed', allow: methods });
        return true;
    }
    if (!ep.public && !getSession(req)) {
        sendJSON(res, 401, { error: 'This endpoint requires you to be signed in' });
        return true;
    }

    let body = null, rawBody = Buffer.alloc(0);
    if (req.method !== 'GET' && req.method !== 'HEAD') {
        try { rawBody = await readBody(req, 32 * 1024 * 1024); } catch (e) { rawBody = Buffer.alloc(0); }
        const ct = String(req.headers['content-type'] || '');
        if (ct.includes('application/json')) {
            try { body = JSON.parse(rawBody.toString('utf8')); } catch (e) { body = null; }
        } else if (ct.includes('application/x-www-form-urlencoded')) {
            body = Object.fromEntries(new URLSearchParams(rawBody.toString('utf8')));
        } else body = rawBody.toString('utf8');
    }

    let finished = false;
    const ctx = {
        req, res,
        method : req.method,
        url    : req.url,
        pathname,
        query  : Object.fromEntries(url.searchParams),
        headers: req.headers,
        body, rawBody,
        ip     : clientIP(req),
        json   : (obj, code) => { finished = true; sendJSON(res, code || 200, obj); },
        text   : (t, code) => { finished = true; sendText(res, code || 200, String(t)); },
        html   : (h, code) => { finished = true; sendHTML(res, code || 200, String(h)); },
        status : c => { res.statusCode = c; return ctx; },
        redirect: (loc, code) => { finished = true; res.writeHead(code || 302, { Location: loc }); res.end(); }
    };
    emitEvent('endpoint.called', { id, name: ep.name, path: ep.path, method: req.method });
    const r = await runEndpoint(id, ctx, 'http');
    if (res.writableEnded || finished) return true;
    if (!r.ok) { sendJSON(res, 500, { error: 'Endpoint failed', detail: r.error }); return true; }
    if (r.result === undefined) { sendJSON(res, 200, { ok: true }); return true; }
    if (typeof r.result === 'string') { sendHTML(res, 200, r.result); return true; }
    sendJSON(res, 200, r.result);
    return true;
}

/* --------------------------------------------------------------------------
 * Main router
 * Priority:  /admin  >  /api/*  >  /s/*  >  public/
 * ----------------------------------------------------------------------- */
async function router(req, res) {
    let url;
    try { url = new URL(req.url, 'http://' + (req.headers.host || 'localhost')); }
    catch (e) { return sendText(res, 400, 'Bad request'); }
    const pathname = url.pathname.replace(/\/{2,}/g, '/');

    /* ---- admin ------------------------------------------------------- */
    if (pathname === '/admin' || pathname === '/admin/')
        return sendHTML(res, 200, adminPage());

    if (pathname.startsWith('/admin/auth/'))
        return adminAuthRoutes(req, res, pathname.slice('/admin/auth'.length));

    if (pathname.startsWith('/admin/api/'))
        return adminApiRoutes(req, res, pathname.slice('/admin/api'.length), url);

    if (pathname.startsWith('/admin'))
        return sendText(res, 404, 'Not found');

    /* ---- custom api endpoints ---------------------------------------- */
    if (pathname === '/api' || pathname.startsWith('/api/')) {
        const handled = await dispatchCustomApi(req, res, pathname, url);
        if (handled) return;
        return sendJSON(res, 404, { error: 'No endpoint is registered at ' + pathname });
    }

    /* ---- shares ------------------------------------------------------- */
    if (pathname.startsWith('/s/')) {
        const rest = pathname.slice(3);
        const slash = rest.indexOf('/');
        const token = slash < 0 ? rest : rest.slice(0, slash);
        const sub   = slash < 0 ? '' : rest.slice(slash);
        if (!token) return sendText(res, 404, 'Not found');
        return shareLanding(req, res, token, sub, pathname);
    }

    /* ---- public ------------------------------------------------------- */
    if (req.method !== 'GET' && req.method !== 'HEAD')
        return sendText(res, 405, 'Method not allowed');
    return servePublic(req, res, pathname);
}

const server = http.createServer((req, res) => {
    Promise.resolve()
        .then(() => router(req, res))
        .catch(err => {
            try {
                if (!res.headersSent) sendJSON(res, 500, { ok: false, error: String(err && err.message || err) });
                else res.end();
            } catch (e) {}
        });
});
server.on('clientError', (err, socket) => {
    try { socket.end('HTTP/1.1 400 Bad Request\r\n\r\n'); } catch (e) {}
});

/* ---- websocket upgrades ------------------------------------------------ */
server.on('upgrade', (req, socket, head) => {
    let url;
    try { url = new URL(req.url, 'http://x'); } catch (e) { return socket.destroy(); }
    if (!getSession(req)) {
        socket.end('HTTP/1.1 401 Unauthorized\r\n\r\n');
        return;
    }
    if (url.pathname === '/admin/ws/terminal') {
        const ws = wsHandshake(req, socket, head);
        if (ws) startTerminal(ws);
        return;
    }
    if (url.pathname === '/admin/ws/exec') {
        const ws = wsHandshake(req, socket, head);
        if (ws) runStreamed(ws, url.searchParams.get('job') || '');
        return;
    }
    socket.destroy();
});

/* --------------------------------------------------------------------------
 * Startup
 * ----------------------------------------------------------------------- */
function startTimers() {
    setInterval(() => { try { sample(); } catch (e) {} }, STAT_INTERVAL).unref?.();
    setInterval(() => { try { cronTick(); } catch (e) {} }, 20000);
    setInterval(gcSessions, 3600000);
    setInterval(gcShares, 3600000);
}

if (SMOKE) {
    /* Boot on an ephemeral port to prove the file runs, then exit cleanly.
     * Used by the Update button before it swaps server.js in. */
    const s2 = http.createServer((q, r) => r.end('ok'));
    s2.listen(0, '127.0.0.1', () => {
        s2.close();
        process.exit(0);
    });
    s2.on('error', e => { console.error('smoke test failed:', e.message); process.exit(1); });
    setTimeout(() => { console.error('smoke test timed out'); process.exit(1); }, 8000);

} else if (RESET) {
    try { fs.unlinkSync(F.admin); } catch (e) {}
    sessions = {}; saveSessions();
    console.log('Admin account removed. Browse to /admin to set up a new one.');
    process.exit(0);

} else {
    bootstrap();

    /* Hand off to systemd on the very first manual run so the portal survives
     * reboots without the operator having to do anything else. */
    const managed = !!process.env.INVOCATION_ID;
    if (!managed && !FOREGROUND && process.getuid && process.getuid() === 0 &&
        fs.existsSync('/etc/systemd/system/' + SERVICE + '.service')) {
        const r = sh('systemctl restart ' + SERVICE + ' 2>&1', 30000);
        const active = sh('systemctl is-active ' + SERVICE).out.trim();
        if (active === 'active') {
            const ips = [];
            const ifs = os.networkInterfaces();
            for (const k in ifs) for (const a of ifs[k])
                if (a.family === 'IPv4' && !a.internal) ips.push(a.address);
            console.log('');
            console.log('  Node Portal is installed and running under systemd.');
            console.log('');
            console.log('    service   ' + SERVICE + '  (enabled, starts on boot)');
            console.log('    files     ' + SRV);
            console.log('    admin     http://' + (ips[0] || 'localhost') + ':' + PORT + '/admin');
            console.log('');
            console.log('  Caddy is installing in the background; check Server/logs/bootstrap.log.');
            console.log('  Follow the portal log with:  journalctl -u ' + SERVICE + ' -f');
            console.log('');
            process.exit(0);
        }
        console.log('systemd could not start the service, staying in the foreground.\n' + r.out);
    }

    server.listen(PORT, '0.0.0.0', () => {
        /* the new build got up: disarm the rollback guard */
        try {
            if (fs.existsSync(F.pending)) {
                const p = readJSON(F.pending, {});
                fs.unlinkSync(F.pending);
                writeJSON(F.report, {
                    ok: true, ts: now(), what: p.what || 'server.js',
                    message: 'Update applied. Previous version saved as ' +
                             (p.backup ? path.basename(p.backup) : 'a backup') + '.'
                });
            }
        } catch (e) {}

        startTimers();
        setTimeout(() => { try { sample(); } catch (e) {} }, 3000);
        emitEvent('server.start', { pid: process.pid, at: now() });
        blog('Listening on 0.0.0.0:' + PORT);
        if (FOREGROUND || !process.env.INVOCATION_ID)
            console.log('Node Portal listening on http://0.0.0.0:' + PORT + '  (admin at /admin)');
    });

    server.on('error', e => {
        console.error('Could not bind port ' + PORT + ': ' + e.message);
        blog('listen error: ' + e.message);
        process.exit(1);
    });

    process.on('uncaughtException', e => {
        blog('uncaught: ' + (e && e.stack || e));
        console.error('uncaught exception:', e);
    });
    process.on('unhandledRejection', e => {
        blog('unhandled rejection: ' + (e && e.stack || e));
    });
}

/* ==========================================================================
 * ADMIN CONSOLE  -  markup, styles and client script
 * ======================================================================= */

const ADMIN_CSS = `
:root{
    color-scheme:dark;
    --bg:#0e1117; --panel:#161b24; --panel2:#1b212c; --sunk:#0a0d13;
    --edge:#262d3a; --edge2:#323c4d;
    --txt:#d8dee9; --dim:#7b8598; --faint:#525c6e;
    --amber:#e8a33d; --cyan:#4ec9d4; --green:#48b884; --red:#e5624c;
    --violet:#a68cf0; --pink:#e07b9a;
    --mono:ui-monospace,SFMono-Regular,"SF Mono",Menlo,Consolas,"Liberation Mono",monospace;
    --r:8px;
}
*{box-sizing:border-box}
html,body{height:100%}
body{margin:0;background:var(--bg);color:var(--txt);font:14px/1.5 var(--mono);
    -webkit-font-smoothing:antialiased;overflow:hidden}
button,input,select,textarea{font:inherit;color:inherit}
::-webkit-scrollbar{width:10px;height:10px}
::-webkit-scrollbar-track{background:var(--sunk)}
::-webkit-scrollbar-thumb{background:#2b3341;border-radius:5px}
::-webkit-scrollbar-thumb:hover{background:#3a4557}
:focus-visible{outline:2px solid var(--amber);outline-offset:2px}

/* ---------- gate (setup / login) ---------- */
#gate{position:fixed;inset:0;display:grid;place-items:center;padding:1.25rem;
    background:radial-gradient(1200px 600px at 50% -10%,#1a2130 0%,var(--bg) 60%);overflow:auto;z-index:50}
.card{width:min(30rem,100%);background:var(--panel);border:1px solid var(--edge);
    border-radius:14px;padding:1.75rem}
.card h1{font-size:1.05rem;margin:0 0 .2rem;letter-spacing:-.01em}
.card .sub{color:var(--dim);font-size:.8rem;margin:0 0 1.4rem}
.eyebrow{font-size:.68rem;letter-spacing:.16em;text-transform:uppercase;color:var(--faint);
    display:block;margin-bottom:.5rem}
label.f{display:block;margin-bottom:.9rem}
label.f span{display:block;font-size:.72rem;color:var(--dim);margin-bottom:.3rem;
    letter-spacing:.06em;text-transform:uppercase}
input[type=text],input[type=password],input[type=number],select,textarea.in{
    width:100%;background:var(--sunk);border:1px solid var(--edge);border-radius:var(--r);
    padding:.6rem .7rem;color:var(--txt)}
input:focus,select:focus,textarea:focus{outline:none;border-color:var(--amber)}
.btn{background:var(--panel2);border:1px solid var(--edge2);color:var(--txt);
    padding:.55rem .9rem;border-radius:var(--r);cursor:pointer;white-space:nowrap;
    transition:border-color .12s,color .12s,background .12s}
.btn:hover:not(:disabled){border-color:var(--amber);color:var(--amber)}
.btn:disabled{opacity:.45;cursor:not-allowed}
.btn.pri{background:var(--amber);border-color:var(--amber);color:#12151c;font-weight:600}
.btn.pri:hover:not(:disabled){background:#f2b155;border-color:#f2b155;color:#12151c}
.btn.danger:hover:not(:disabled){border-color:var(--red);color:var(--red)}
.btn.sm{padding:.32rem .55rem;font-size:.76rem}
.row{display:flex;gap:.6rem;align-items:center;flex-wrap:wrap}
.msg{padding:.65rem .8rem;border-radius:var(--r);font-size:.82rem;margin-bottom:1rem;
    border:1px solid transparent;line-height:1.5}
.msg.err{background:#2a1618;border-color:#5c2b2b;color:#f0a79b}
.msg.ok{background:#12241c;border-color:#245039;color:#8fd9b4}
.msg.info{background:#141c2b;border-color:#2b3a54;color:#9fb6d8}
.qr{background:#fff;padding:.6rem;border-radius:var(--r);display:inline-block;line-height:0}
.secret{font-size:.78rem;word-break:break-all;background:var(--sunk);border:1px solid var(--edge);
    padding:.55rem .65rem;border-radius:var(--r);color:var(--cyan);user-select:all}
.codes{display:grid;grid-template-columns:repeat(2,1fr);gap:.4rem;margin:.75rem 0}
.codes code{background:var(--sunk);border:1px solid var(--edge);padding:.45rem .5rem;
    border-radius:6px;font-size:.82rem;color:var(--amber);text-align:center;user-select:all}

/* ---------- app shell ---------- */
#app{display:none;height:100%;grid-template-rows:auto 1fr}
#app.on{display:grid}
header.top{display:flex;align-items:center;gap:1rem;padding:.55rem .9rem;
    border-bottom:1px solid var(--edge);background:var(--panel);flex-wrap:wrap}
.brand{display:flex;align-items:center;gap:.55rem;font-weight:600;letter-spacing:-.01em}
.dot{width:8px;height:8px;border-radius:50%;background:var(--green);
    box-shadow:0 0 0 3px rgba(72,184,132,.16)}
.dot.bad{background:var(--red);box-shadow:0 0 0 3px rgba(229,98,76,.16)}
.top .meta{color:var(--faint);font-size:.74rem;display:flex;gap:.9rem;flex-wrap:wrap}
.top .sp{flex:1}
main.shell{display:grid;grid-template-columns:180px 1fr;min-height:0}
nav.rail{border-right:1px solid var(--edge);background:var(--panel);padding:.6rem .5rem;
    display:flex;flex-direction:column;gap:.15rem;overflow:auto}
nav.rail button{background:none;border:0;text-align:left;padding:.55rem .65rem;border-radius:var(--r);
    color:var(--dim);cursor:pointer;display:flex;align-items:center;gap:.55rem;font-size:.86rem}
nav.rail button:hover{background:var(--panel2);color:var(--txt)}
nav.rail button.on{background:var(--panel2);color:var(--amber);box-shadow:inset 2px 0 0 var(--amber)}
nav.rail .k{color:var(--faint);font-size:.7rem;margin-left:auto}
nav.rail .grp{font-size:.64rem;letter-spacing:.16em;text-transform:uppercase;color:var(--faint);
    padding:.9rem .65rem .35rem}
section.pane{display:none;min-height:0;overflow:auto;padding:1.1rem 1.25rem 2.5rem}
section.pane.on{display:block}
section.pane.flush{padding:0;display:none}
section.pane.flush.on{display:grid}

h2.title{font-size:.95rem;margin:0 0 .15rem;letter-spacing:-.01em}
p.hint{color:var(--dim);font-size:.78rem;margin:0 0 1.1rem}
.bar{display:flex;gap:.5rem;align-items:center;flex-wrap:wrap;margin-bottom:1rem}
.bar .sp{flex:1}

/* ---------- cards & charts ---------- */
.grid4{display:grid;grid-template-columns:repeat(auto-fit,minmax(210px,1fr));gap:.75rem;margin-bottom:1rem}
.stat{background:var(--panel);border:1px solid var(--edge);border-radius:12px;padding:.8rem .9rem;
    position:relative;overflow:hidden}
.stat .lab{font-size:.66rem;letter-spacing:.14em;text-transform:uppercase;color:var(--faint)}
.stat .big{font-size:1.65rem;line-height:1.15;margin-top:.25rem;font-variant-numeric:tabular-nums}
.stat .sub{font-size:.72rem;color:var(--dim);margin-top:.1rem}
.stat svg.spark{position:absolute;right:0;bottom:0;left:0;height:34px;width:100%;opacity:.5}
.chart{background:var(--panel);border:1px solid var(--edge);border-radius:12px;padding:.85rem .5rem .4rem .5rem;margin-bottom:.75rem}
.chart h3{font-size:.7rem;letter-spacing:.14em;text-transform:uppercase;color:var(--faint);
    margin:0 0 .1rem .55rem;display:flex;gap:.7rem;align-items:baseline;flex-wrap:wrap}
.chart h3 em{font-style:normal;color:var(--dim);letter-spacing:0;text-transform:none;font-size:.74rem}
.chart svg{width:100%;display:block;height:130px}
.legend{display:flex;gap:.8rem;font-size:.7rem;color:var(--dim);margin:.1rem 0 0 .55rem}
.legend i{display:inline-block;width:8px;height:2px;vertical-align:middle;margin-right:.3rem}
.grid2{display:grid;grid-template-columns:repeat(auto-fit,minmax(320px,1fr));gap:.75rem}
table.kv{width:100%;border-collapse:collapse;font-size:.8rem}
table.kv td{padding:.32rem 0;border-bottom:1px solid #1c222d;vertical-align:top}
table.kv td:first-child{color:var(--faint);width:9.5rem;white-space:nowrap}
.panel{background:var(--panel);border:1px solid var(--edge);border-radius:12px;padding:.9rem 1rem}
.panel h3{font-size:.7rem;letter-spacing:.14em;text-transform:uppercase;color:var(--faint);margin:0 0 .7rem}
.usage{margin-bottom:.7rem}
.usage .t{display:flex;justify-content:space-between;font-size:.76rem;margin-bottom:.25rem}
.usage .t b{font-weight:400}
.usage .t span{color:var(--faint)}
.track{height:6px;background:var(--sunk);border-radius:3px;overflow:hidden}
.track i{display:block;height:100%;background:var(--cyan);border-radius:3px}
.track i.warn{background:var(--amber)}
.track i.hot{background:var(--red)}

/* ---------- console output ---------- */
pre.out{background:var(--sunk);border:1px solid var(--edge);border-radius:var(--r);
    padding:.7rem .8rem;font-size:.76rem;line-height:1.5;max-height:20rem;overflow:auto;
    white-space:pre-wrap;word-break:break-word;margin:.6rem 0 0;color:#b9c2d0}
.mgrid{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:.45rem}

/* ---------- code editor ---------- */
.editwrap{position:relative;background:var(--sunk);border:1px solid var(--edge);border-radius:10px;
    overflow:hidden;display:grid;grid-template-columns:auto 1fr;min-height:0}
.gutter{padding:.75rem .5rem .75rem .75rem;color:#3c4557;font-size:12.5px;line-height:1.6;
    text-align:right;user-select:none;background:#080b10;border-right:1px solid #1a212c;
    overflow:hidden;white-space:pre;font-variant-numeric:tabular-nums}
.codebox{position:relative;overflow:auto}
.codebox pre,.codebox textarea{margin:0;padding:.75rem .9rem;font:12.5px/1.6 var(--mono);
    tab-size:4;white-space:pre;word-wrap:normal;border:0;letter-spacing:0}
.codebox pre{pointer-events:none;color:var(--txt)}
.codebox textarea{position:absolute;inset:0;width:100%;height:100%;resize:none;background:transparent;
    color:transparent;caret-color:var(--amber);overflow:hidden;outline:none}
.codebox textarea::selection{background:rgba(232,163,61,.28)}
/* token colours */
.t-key{color:#c792ea}.t-str{color:#a5d6a0}.t-num{color:#f0a35e}.t-com{color:#5a6577;font-style:italic}
.t-fn{color:#82aaff}.t-op{color:#89ddff}.t-lit{color:#f78c6c}.t-reg{color:#e0a5c8}
.t-tag{color:#e8a33d}.t-att{color:#82aaff}.t-val{color:#a5d6a0}.t-dt{color:#5a6577}
.t-sel{color:#e8a33d}.t-prop{color:#82aaff}

/* ---------- files ---------- */
.crumbs{display:flex;gap:.2rem;align-items:center;flex-wrap:wrap;font-size:.8rem;margin-bottom:.7rem}
.crumbs a{color:var(--cyan);cursor:pointer;text-decoration:none;padding:.1rem .25rem;border-radius:4px}
.crumbs a:hover{background:var(--panel2)}
.crumbs s{color:var(--faint);text-decoration:none}
table.fl{width:100%;border-collapse:collapse;font-size:.82rem}
table.fl th{text-align:left;font-weight:400;font-size:.66rem;letter-spacing:.14em;
    text-transform:uppercase;color:var(--faint);padding:.4rem .5rem;border-bottom:1px solid var(--edge)}
table.fl td{padding:.4rem .5rem;border-bottom:1px solid #1a202a;vertical-align:middle}
table.fl tr:hover td{background:#151b25}
table.fl .nm{cursor:pointer;display:flex;align-items:center;gap:.5rem}
table.fl .nm:hover{color:var(--amber)}
table.fl .ic{width:1.1rem;text-align:center;color:var(--faint);flex:none}
table.fl .ic.d{color:var(--amber)}
table.fl td.r{text-align:right;color:var(--faint);white-space:nowrap;font-size:.76rem}
table.fl td.acts{text-align:right;white-space:nowrap}
table.fl td.acts button{background:none;border:0;color:var(--faint);cursor:pointer;
    padding:.15rem .3rem;border-radius:4px;font-size:.74rem}
table.fl td.acts button:hover{color:var(--amber);background:var(--panel2)}
#drop{position:fixed;inset:0;background:rgba(14,17,23,.86);z-index:40;display:none;
    place-items:center;border:2px dashed var(--amber);pointer-events:none}
#drop.on{display:grid}
#drop div{text-align:center;color:var(--amber)}
.empty{color:var(--faint);font-size:.82rem;padding:2rem;text-align:center}

/* ---------- modal ---------- */
.modal{position:fixed;inset:0;background:rgba(8,10,14,.72);display:none;z-index:60;
    padding:1.25rem;overflow:auto}
.modal.on{display:grid;place-items:center}
.modal .box{width:min(64rem,100%);max-height:90vh;background:var(--panel);border:1px solid var(--edge);
    border-radius:14px;display:flex;flex-direction:column;overflow:hidden}
.modal .box.narrow{width:min(30rem,100%)}
.modal header{display:flex;align-items:center;gap:.75rem;padding:.75rem 1rem;
    border-bottom:1px solid var(--edge)}
.modal header h3{margin:0;font-size:.88rem;font-weight:600;flex:1;overflow:hidden;
    text-overflow:ellipsis;white-space:nowrap}
.modal .body{padding:1rem;overflow:auto;min-height:0;display:flex;flex-direction:column}
.modal footer{display:flex;gap:.5rem;padding:.75rem 1rem;border-top:1px solid var(--edge);
    align-items:center;flex-wrap:wrap}
.modal footer .sp{flex:1}
.x{background:none;border:0;color:var(--faint);font-size:1.1rem;cursor:pointer;padding:.1rem .4rem;
    border-radius:4px;line-height:1}
.x:hover{color:var(--red);background:var(--panel2)}

/* ---------- shares ---------- */
.pill{display:inline-block;font-size:.68rem;padding:.12rem .45rem;border-radius:99px;
    border:1px solid var(--edge2);color:var(--dim)}
.pill.edit{border-color:#5b4a1f;color:var(--amber);background:#241d10}
.pill.read{border-color:#1f4a4d;color:var(--cyan);background:#102123}
.pill.dead{border-color:#4a2020;color:var(--red);background:#241010}
.pill.live{border-color:#1f4a35;color:var(--green);background:#102319}
.link{font-size:.76rem;color:var(--cyan);word-break:break-all;user-select:all}

/* ---------- api ---------- */
.split{display:grid;grid-template-columns:250px 1fr;gap:.75rem;min-height:0}
.list{background:var(--panel);border:1px solid var(--edge);border-radius:12px;overflow:auto;padding:.35rem}
.list button{width:100%;text-align:left;background:none;border:0;padding:.5rem .6rem;border-radius:7px;
    cursor:pointer;color:var(--dim)}
.list button:hover{background:var(--panel2);color:var(--txt)}
.list button.on{background:var(--panel2);color:var(--amber)}
.list button b{display:block;font-weight:500;font-size:.82rem}
.list button small{font-size:.7rem;color:var(--faint);display:block;margin-top:.1rem;
    overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.chips{display:flex;gap:.35rem;flex-wrap:wrap}
.chip{font-size:.72rem;padding:.28rem .5rem;border-radius:6px;border:1px solid var(--edge2);
    background:var(--sunk);color:var(--dim);cursor:pointer;user-select:none}
.chip.on{border-color:var(--amber);color:var(--amber);background:#241d10}

/* ---------- terminal ---------- */
#termpane{grid-template-rows:auto 1fr}
#termbar{display:flex;gap:.5rem;align-items:center;padding:.5rem .8rem;
    border-bottom:1px solid var(--edge);background:var(--panel);flex-wrap:wrap}
#term{background:#080b10;overflow:auto;padding:.5rem .7rem;font:13px/1.32 var(--mono);
    white-space:pre;cursor:text;min-height:0;letter-spacing:0}
#term b{font-weight:700}
#term u{text-decoration:underline}
#term .cur{background:var(--amber);color:#080b10}

@media(max-width:820px){
    main.shell{grid-template-columns:1fr;grid-template-rows:auto 1fr}
    nav.rail{flex-direction:row;overflow-x:auto;border-right:0;border-bottom:1px solid var(--edge);
        padding:.4rem}
    nav.rail .grp,nav.rail .k{display:none}
    nav.rail button.on{box-shadow:inset 0 -2px 0 var(--amber)}
    .split{grid-template-columns:1fr}
    .top .meta{display:none}
}
@media(prefers-reduced-motion:reduce){*{transition:none!important;animation:none!important}}
`;

const ADMIN_BODY = `
<div id="gate"><div class="card" id="gatecard"></div></div>

<div id="app">
  <header class="top">
    <div class="brand"><span class="dot" id="hdot"></span><span id="hname">Node Portal</span></div>
    <div class="meta">
      <span id="hhost"></span><span id="hup"></span><span id="hload"></span><span id="hip"></span>
    </div>
    <div class="sp"></div>
    <span class="meta" id="huser"></span>
    <button class="btn sm" id="signout">Sign out</button>
  </header>

  <main class="shell">
    <nav class="rail">
      <span class="grp">Server</span>
      <button data-tab="dash" class="on">Dashboard<span class="k">1</span></button>
      <button data-tab="term">Terminal<span class="k">2</span></button>
      <button data-tab="caddy">Caddy<span class="k">3</span></button>
      <span class="grp">Content</span>
      <button data-tab="files">Files<span class="k">4</span></button>
      <button data-tab="shares">Shares<span class="k">5</span></button>
      <span class="grp">Code</span>
      <button data-tab="api">API<span class="k">6</span></button>
      <button data-tab="editor">server.js<span class="k">7</span></button>
    </nav>

    <!-- ============ dashboard ============ -->
    <section class="pane on" id="pane-dash">
      <div id="updnote"></div>
      <div class="grid4" id="cards"></div>
      <div class="grid2">
        <div>
          <div class="chart" id="c-cpu"></div>
          <div class="chart" id="c-mem"></div>
        </div>
        <div>
          <div class="chart" id="c-net"></div>
          <div class="chart" id="c-disk"></div>
        </div>
      </div>
      <div class="grid2" style="margin-top:.75rem">
        <div class="panel"><h3>System</h3><table class="kv" id="sysinfo"></table></div>
        <div class="panel"><h3>Storage</h3><div id="disks"></div></div>
      </div>
      <div class="panel" style="margin-top:.75rem">
        <h3>Maintenance</h3>
        <div class="mgrid" id="mbtns"></div>
        <pre class="out" id="mout" style="display:none"></pre>
      </div>
    </section>

    <!-- ============ terminal ============ -->
    <section class="pane flush" id="pane-term">
      <div id="termbar">
        <span class="dot" id="tdot"></span>
        <span style="font-size:.76rem;color:var(--dim)" id="tstat">Not connected</span>
        <div class="sp" style="flex:1"></div>
        <button class="btn sm" id="tnew">New session</button>
        <button class="btn sm" id="tclear">Clear</button>
      </div>
      <div id="term" tabindex="0"></div>
    </section>

    <!-- ============ caddy ============ -->
    <section class="pane" id="pane-caddy">
      <h2 class="title">Caddy</h2>
      <p class="hint">Caddy terminates TLS on 80/443 and proxies to this server on port ${PORT}. Point your domain's DNS here and it will fetch a certificate on its own.</p>
      <div class="grid2" style="margin-bottom:.9rem">
        <div class="panel"><h3>Caddy service</h3><table class="kv" id="caddystat"></table>
          <div class="row" style="margin-top:.7rem">
            <button class="btn sm" data-job="reload-caddy">Reload config</button>
            <button class="btn sm" data-job="restart-caddy">Restart Caddy</button>
            <button class="btn sm" id="caddyinstall">Install Caddy</button>
          </div>
        </div>
        <div class="panel"><h3>Portal service</h3><table class="kv" id="nodestat"></table>
          <div class="row" style="margin-top:.7rem">
            <button class="btn sm" data-job="restart-node">Restart portal</button>
            <button class="btn sm" data-job="service-status">Show status</button>
          </div>
        </div>
      </div>
      <div class="bar">
        <span class="eyebrow" style="margin:0">Caddyfile</span>
        <div class="sp"></div>
        <select id="caddybk" class="btn sm" style="max-width:14rem"></select>
        <button class="btn sm" id="caddyrevert">Load backup</button>
        <button class="btn pri sm" id="caddysave">Validate and apply</button>
      </div>
      <div id="caddymsg"></div>
      <div class="editwrap" style="height:26rem">
        <div class="gutter" id="caddy-g"></div>
        <div class="codebox"><pre id="caddy-h"></pre><textarea id="caddy-t" spellcheck="false"></textarea></div>
      </div>
      <div class="panel" style="margin-top:.9rem"><h3>Recent Caddy log</h3>
        <pre class="out" id="caddylog"></pre></div>
    </section>

    <!-- ============ files ============ -->
    <section class="pane" id="pane-files">
      <div class="bar">
        <button class="btn sm" id="f-up">Up</button>
        <button class="btn sm" id="f-home">Server</button>
        <button class="btn sm" id="f-root">/</button>
        <button class="btn sm" id="f-refresh">Refresh</button>
        <div class="sp"></div>
        <button class="btn sm" id="f-newfile">New file</button>
        <button class="btn sm" id="f-newdir">New folder</button>
        <button class="btn sm" id="f-upload">Upload</button>
        <button class="btn sm" id="f-zip">Download zip</button>
        <button class="btn sm danger" id="f-del">Delete</button>
        <input type="file" id="f-input" multiple hidden>
      </div>
      <div class="crumbs" id="crumbs"></div>
      <div id="filemsg"></div>
      <div class="panel" style="padding:.35rem .5rem">
        <table class="fl">
          <thead><tr>
            <th style="width:1.6rem"><input type="checkbox" id="f-all"></th>
            <th>Name</th><th style="width:6rem" class="r">Size</th>
            <th style="width:10rem" class="r">Modified</th>
            <th style="width:4.5rem" class="r">Mode</th>
            <th style="width:11rem"></th>
          </tr></thead>
          <tbody id="filerows"></tbody>
        </table>
      </div>
    </section>

    <!-- ============ shares ============ -->
    <section class="pane" id="pane-shares">
      <h2 class="title">Shares</h2>
      <p class="hint">Every share is a random unguessable link. Read links download; edit links open a plain editor and accept uploads. No sign in required for either.</p>
      <div class="bar">
        <button class="btn sm" id="sh-refresh">Refresh</button>
        <div class="sp"></div>
        <button class="btn sm danger" id="sh-purge">Remove expired</button>
      </div>
      <div class="panel" style="padding:.35rem .5rem">
        <table class="fl">
          <thead><tr><th>Label</th><th>Link</th><th style="width:5rem">Access</th>
            <th style="width:11rem">Expires</th><th style="width:4rem" class="r">Hits</th>
            <th style="width:9rem"></th></tr></thead>
          <tbody id="sharerows"></tbody>
        </table>
      </div>
    </section>

    <!-- ============ api ============ -->
    <section class="pane" id="pane-api">
      <div class="bar">
        <h2 class="title" style="margin:0">Endpoints</h2>
        <div class="sp"></div>
        <button class="btn sm" id="a-new">New endpoint</button>
        <button class="btn sm" id="a-run">Run now</button>
        <button class="btn sm danger" id="a-del">Delete</button>
        <button class="btn pri sm" id="a-save">Save endpoint</button>
      </div>
      <div id="apimsg"></div>
      <div class="split" style="height:calc(100vh - 11rem)">
        <div class="list" id="apilist"></div>
        <div style="display:flex;flex-direction:column;gap:.6rem;min-height:0">
          <div class="panel" style="padding:.75rem .9rem">
            <div class="row">
              <label class="f" style="flex:1;margin:0;min-width:11rem"><span>Name</span>
                <input type="text" id="a-name" placeholder="Daily backup"></label>
              <label class="f" style="flex:1;margin:0;min-width:11rem"><span>Path</span>
                <input type="text" id="a-path" placeholder="/api/daily-backup"></label>
            </div>
            <div class="row" style="margin-top:.7rem;align-items:flex-start">
              <div><span class="eyebrow">Methods</span><div class="chips" id="a-methods"></div></div>
              <div><span class="eyebrow">Options</span><div class="chips">
                <span class="chip" id="a-enabled">Enabled</span>
                <span class="chip" id="a-public">No sign in needed</span>
              </div></div>
            </div>
            <div class="row" style="margin-top:.7rem;align-items:flex-start">
              <div style="min-width:15rem"><span class="eyebrow">Schedule</span>
                <div class="row">
                  <span class="chip" id="a-schedon">On a schedule</span>
                  <input type="text" id="a-sched" placeholder="0 3 * * *" style="width:9rem">
                </div>
                <small style="color:var(--faint);font-size:.7rem" id="a-schedtxt"></small>
              </div>
              <div style="flex:1"><span class="eyebrow">Also run on these events</span>
                <div class="chips" id="a-events"></div></div>
            </div>
          </div>
          <span class="eyebrow" style="margin:0">Handler &mdash; an async function body receiving ctx</span>
          <div class="editwrap" style="flex:1;min-height:12rem">
            <div class="gutter" id="api-g"></div>
            <div class="codebox"><pre id="api-h"></pre><textarea id="api-t" spellcheck="false"></textarea></div>
          </div>
          <pre class="out" id="apiout" style="display:none;max-height:11rem"></pre>
        </div>
      </div>
    </section>

    <!-- ============ server.js editor ============ -->
    <section class="pane" id="pane-editor">
      <div class="bar">
        <h2 class="title" style="margin:0">server.js</h2>
        <span class="pill" id="ed-path"></span>
        <div class="sp"></div>
        <select id="ed-bk" class="btn sm" style="max-width:15rem"></select>
        <button class="btn sm" id="ed-load">Load backup</button>
        <button class="btn sm" id="ed-reload">Discard changes</button>
        <button class="btn pri sm" id="ed-save">Check and apply</button>
      </div>
      <p class="hint">Applying runs a syntax check and a boot test, saves the current file to backups, then restarts the service. If the new build fails to come up it is rolled back on its own.</p>
      <div id="edmsg"></div>
      <div class="editwrap" style="height:calc(100vh - 14rem)">
        <div class="gutter" id="ed-g"></div>
        <div class="codebox"><pre id="ed-h"></pre><textarea id="ed-t" spellcheck="false"></textarea></div>
      </div>
    </section>
  </main>
</div>

<div id="drop"><div><div style="font-size:2rem">&#8595;</div><div>Drop to upload here</div></div></div>
<div class="modal" id="modal"><div class="box" id="modalbox"></div></div>
`;

/* ---- client script: core, auth gate, tabs, syntax highlighting ---------- */
const ADMIN_JS_CORE = String.raw`
"use strict";
var $ = function(id){ return document.getElementById(id); };
var h = function(s){ return String(s==null?'':s).replace(/[&<>"']/g, function(c){
    return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]; }); };
var state = { tab:'dash', path:null, files:[], sel:{}, apis:[], curApi:null, overview:null };

function api(p, opts){
    opts = opts || {};
    opts.headers = Object.assign({'X-Np':'1'}, opts.headers||{});
    if(opts.json !== undefined){
        opts.method = opts.method || 'POST';
        opts.headers['Content-Type']='application/json';
        opts.body = JSON.stringify(opts.json);
        delete opts.json;
    }
    return fetch('/admin'+p, opts).then(function(r){
        if(r.status===401){ location.reload(); throw new Error('signed out'); }
        var ct = r.headers.get('content-type')||'';
        if(ct.indexOf('application/json')<0) return r.text().then(function(t){ return {ok:false,error:t}; });
        return r.json();
    });
}
function bytes(n){
    if(n===null||n===undefined||isNaN(n)) return '-';
    var u=['B','KB','MB','GB','TB','PB'],i=0; n=Number(n);
    while(n>=1024&&i<u.length-1){n/=1024;i++;}
    return (i===0?Math.round(n):n.toFixed(1))+' '+u[i];
}
function rate(n){ return bytes(n)+'/s'; }
function dur(s){
    s=Math.floor(s); var d=Math.floor(s/86400),hh=Math.floor(s%86400/3600),m=Math.floor(s%3600/60);
    if(d) return d+'d '+hh+'h'; if(hh) return hh+'h '+m+'m';
    if(m) return m+'m'; return s+'s';
}
function when(ts){ if(!ts) return '-'; var d=new Date(ts);
    return d.toLocaleDateString(undefined,{month:'short',day:'numeric'})+' '+
           d.toLocaleTimeString(undefined,{hour:'2-digit',minute:'2-digit'}); }
function note(box, kind, text){
    var e = typeof box==='string' ? $(box) : box;
    if(!e) return;
    if(!text){ e.innerHTML=''; return; }
    e.innerHTML = '<div class="msg '+kind+'">'+text+'</div>';
}
function toast(text, kind){
    note('filemsg', kind||'ok', h(text));
    setTimeout(function(){ note('filemsg',''); }, 4000);
}

/* ---------------- syntax highlighting ---------------- */
var JS_KEY = /^(?:const|let|var|function|return|if|else|for|while|do|switch|case|break|continue|new|delete|typeof|instanceof|void|in|of|this|class|extends|super|try|catch|finally|throw|async|await|yield|import|export|from|as|default|static|get|set)$/;
var JS_LIT = /^(?:true|false|null|undefined|NaN|Infinity|arguments)$/;

function hlJS(src){
    var re = /(\/\*[\s\S]*?\*\/|\/\/[^\n]*)|("(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|\x60(?:\\[\s\S]|[^\x60\\])*\x60)|(\b0[xX][0-9a-fA-F]+\b|\b\d[\d_]*(?:\.\d+)?(?:[eE][+-]?\d+)?\b)|([A-Za-z_$][\w$]*)|([{}()\[\];,.:?!<>=+\-*/%&|^~]+)/g;
    var out='', last=0, m;
    while((m = re.exec(src))){
        out += h(src.slice(last, m.index));
        last = re.lastIndex;
        if(m[1])      out += '<span class="t-com">'+h(m[1])+'</span>';
        else if(m[2]) out += '<span class="t-str">'+h(m[2])+'</span>';
        else if(m[3]) out += '<span class="t-num">'+h(m[3])+'</span>';
        else if(m[4]){
            var w = m[4];
            var after = src.slice(re.lastIndex).match(/^\s*\(/);
            if(JS_KEY.test(w))      out += '<span class="t-key">'+h(w)+'</span>';
            else if(JS_LIT.test(w)) out += '<span class="t-lit">'+h(w)+'</span>';
            else if(after)          out += '<span class="t-fn">'+h(w)+'</span>';
            else out += h(w);
        }
        else if(m[5]) out += '<span class="t-op">'+h(m[5])+'</span>';
    }
    return out + h(src.slice(last));
}
function hlCSSBody(src){
    var re = /(\/\*[\s\S]*?\*\/)|("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')|([-a-zA-Z]+)(\s*:)|(\{|\}|;)/g;
    var out='', last=0, m;
    while((m = re.exec(src))){
        out += h(src.slice(last,m.index)); last = re.lastIndex;
        if(m[1]) out += '<span class="t-com">'+h(m[1])+'</span>';
        else if(m[2]) out += '<span class="t-str">'+h(m[2])+'</span>';
        else if(m[3]) out += '<span class="t-prop">'+h(m[3])+'</span>'+h(m[4]);
        else out += '<span class="t-op">'+h(m[5])+'</span>';
    }
    return out + h(src.slice(last));
}
function hlHTML(src){
    var out='', i=0;
    var re = /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<!DOCTYPE[^>]*>|<\/?[A-Za-z][\w:-]*((?:"[^"]*"|'[^']*'|[^>"'])*)>/g;
    var m;
    while((m = re.exec(src))){
        out += h(src.slice(i, m.index));
        var tag = m[0];
        i = re.lastIndex;
        if(tag.slice(0,4)==='<!--'){ out += '<span class="t-com">'+h(tag)+'</span>'; continue; }
        if(/^<!DOCTYPE/i.test(tag)){ out += '<span class="t-dt">'+h(tag)+'</span>'; continue; }
        /* colour the tag name then attributes */
        var tm = /^<\/?([A-Za-z][\w:-]*)/.exec(tag);
        var name = tm ? tm[1] : '';
        var head = tag.slice(0, tm[0].length);
        var rest = tag.slice(tm[0].length);
        out += '<span class="t-op">'+h(head.slice(0, head.length-name.length))+'</span>' +
               '<span class="t-tag">'+h(name)+'</span>';
        out += rest.replace(/([\w:-]+)(\s*=\s*)("[^"]*"|'[^']*'|[^\s>]+)|([\w:-]+)|([\s\S])/g,
            function(_, a, eq, v, bare, other){
                if(a) return '<span class="t-att">'+h(a)+'</span>'+h(eq)+'<span class="t-val">'+h(v)+'</span>';
                if(bare) return '<span class="t-att">'+h(bare)+'</span>';
                return h(other);
            });
        /* inline script / style bodies */
        if(/^<script/i.test(tag) && !/\/>$/.test(tag)){
            var end = src.toLowerCase().indexOf('</script', i);
            if(end>=0){ out += hlJS(src.slice(i,end)); i = end; }
        } else if(/^<style/i.test(tag) && !/\/>$/.test(tag)){
            var e2 = src.toLowerCase().indexOf('</style', i);
            if(e2>=0){ out += hlCSSBody(src.slice(i,e2)); i = e2; }
        }
    }
    return out + h(src.slice(i));
}
function hlCSS(src){
    var re = /(\/\*[\s\S]*?\*\/)|(\{[\s\S]*?\})|([^{}]+)(?=\{)/g;
    var out='', last=0, m;
    while((m = re.exec(src))){
        out += h(src.slice(last,m.index)); last = re.lastIndex;
        if(m[1]) out += '<span class="t-com">'+h(m[1])+'</span>';
        else if(m[2]) out += '<span class="t-op">{</span>'+hlCSSBody(m[2].slice(1,-1))+'<span class="t-op">}</span>';
        else out += '<span class="t-sel">'+h(m[3])+'</span>';
    }
    return out + h(src.slice(last));
}
function hlCaddy(src){
    var re = /(#[^\n]*)|("(?:\\.|[^"\\])*")|(\{|\})|(\b[a-z_]+(?=\s))/g;
    var out='', last=0, m;
    while((m = re.exec(src))){
        out += h(src.slice(last,m.index)); last = re.lastIndex;
        if(m[1]) out += '<span class="t-com">'+h(m[1])+'</span>';
        else if(m[2]) out += '<span class="t-str">'+h(m[2])+'</span>';
        else if(m[3]) out += '<span class="t-op">'+h(m[3])+'</span>';
        else out += '<span class="t-tag">'+h(m[4])+'</span>';
    }
    return out + h(src.slice(last));
}
function hlAuto(src, name){
    var e = (name||'').toLowerCase();
    if(/\.(html?|vue|svelte)$/.test(e)) return hlHTML(src);
    if(/\.(css|scss|less)$/.test(e))    return hlCSS(src);
    if(/caddyfile/.test(e))             return hlCaddy(src);
    if(/\.json$/.test(e))               return hlJS(src);
    if(/\.(js|mjs|cjs|jsx|ts)$/.test(e))return hlJS(src);
    return h(src);
}

/* ---------------- code editor binding ---------------- */
function bindEditor(taId, preId, gutId, langFn){
    var ta = $(taId), pre = $(preId), gut = $(gutId);
    var box = ta.parentNode;
    function paint(){
        var v = ta.value;
        pre.innerHTML = langFn(v) + '\n';
        var lines = v.split('\n').length;
        var g = '';
        for(var i=1;i<=lines;i++) g += i + '\n';
        gut.textContent = g;
        ta.style.height = pre.scrollHeight + 'px';
        ta.style.width  = Math.max(box.clientWidth, pre.scrollWidth) + 'px';
    }
    function syncScroll(){ gut.scrollTop = box.scrollTop; }
    ta.addEventListener('input', paint);
    box.addEventListener('scroll', syncScroll);
    ta.addEventListener('keydown', function(e){
        if(e.key === 'Tab'){
            e.preventDefault();
            var s = ta.selectionStart, en = ta.selectionEnd, v = ta.value;
            if(s !== en && v.slice(s,en).indexOf('\n') >= 0){
                var ls = v.lastIndexOf('\n', s-1)+1;
                var block = v.slice(ls, en);
                var next = e.shiftKey
                    ? block.replace(/^ {1,4}/gm,'')
                    : block.replace(/^/gm,'    ');
                ta.value = v.slice(0,ls) + next + v.slice(en);
                ta.selectionStart = ls; ta.selectionEnd = ls + next.length;
            } else {
                ta.value = v.slice(0,s) + '    ' + v.slice(en);
                ta.selectionStart = ta.selectionEnd = s + 4;
            }
            paint();
        }
        if(e.key === 'Enter'){
            var s2 = ta.selectionStart, v2 = ta.value;
            var ls2 = v2.lastIndexOf('\n', s2-1)+1;
            var indent = (v2.slice(ls2, s2).match(/^[ \t]*/)||[''])[0];
            if(/[{(\[]\s*$/.test(v2.slice(ls2, s2))) indent += '    ';
            if(indent){
                e.preventDefault();
                ta.value = v2.slice(0,s2) + '\n' + indent + v2.slice(ta.selectionEnd);
                ta.selectionStart = ta.selectionEnd = s2 + 1 + indent.length;
                paint();
            }
        }
        if((e.ctrlKey||e.metaKey) && e.key === 's'){ e.preventDefault();
            var ev = new CustomEvent('editor-save'); ta.dispatchEvent(ev); }
    });
    window.addEventListener('resize', paint);
    return { set:function(v){ ta.value = v; paint(); }, get:function(){ return ta.value; },
             paint:paint, ta:ta };
}
`;

/* ---- client script: gate (setup / sign in) and tab shell ---------------- */
const ADMIN_JS_GATE = String.raw`
function gateSetup(){
    var c = $('gatecard');
    c.innerHTML =
      '<span class="eyebrow">First run</span>' +
      '<h1>Create the admin account</h1>' +
      '<p class="sub">One account controls this portal. Set a password, then pair an authenticator app.</p>' +
      '<div id="gmsg"></div>' +
      '<label class="f"><span>Username</span><input type="text" id="su" autocomplete="username"></label>' +
      '<label class="f"><span>Password</span><input type="password" id="sp" autocomplete="new-password"></label>' +
      '<label class="f"><span>Repeat password</span><input type="password" id="sp2" autocomplete="new-password"></label>' +
      '<div style="display:flex;gap:1rem;align-items:flex-start;flex-wrap:wrap;margin:1.1rem 0">' +
        '<div class="qr" id="qr"></div>' +
        '<div style="flex:1;min-width:12rem">' +
          '<span class="eyebrow">Scan, or type this key</span>' +
          '<div class="secret" id="sec"></div>' +
          '<label class="f" style="margin-top:.8rem"><span>Code from the app</span>' +
            '<input type="text" id="sc" inputmode="numeric" maxlength="6" placeholder="000000" autocomplete="one-time-code"></label>' +
        '</div>' +
      '</div>' +
      '<button class="btn pri" id="sgo" style="width:100%">Create account</button>';

    api('/auth/setup/begin', {method:'POST'}).then(function(r){
        if(!r.ok){ note('gmsg','err',h(r.error||'Setup could not start')); return; }
        state.nonce = r.nonce;
        $('qr').innerHTML = r.qr || '<div style="padding:2rem;color:#333">no qr</div>';
        $('sec').textContent = r.secret;
    });
    $('sgo').onclick = function(){
        var u=$('su').value.trim(), p=$('sp').value, p2=$('sp2').value, code=$('sc').value.trim();
        if(p !== p2) return note('gmsg','err','The two passwords do not match.');
        note('gmsg','info','Creating the account...');
        api('/auth/setup/complete', {json:{nonce:state.nonce, username:u, password:p, code:code}})
        .then(function(r){
            if(!r.ok) return note('gmsg','err',h(r.error));
            gateBackupCodes(r.backupCodes);
        });
    };
    $('sc').addEventListener('keydown', function(e){ if(e.key==='Enter') $('sgo').click(); });
}

function gateBackupCodes(codes){
    var c = $('gatecard');
    c.innerHTML =
      '<span class="eyebrow">Save these now</span>' +
      '<h1>Ten backup codes</h1>' +
      '<p class="sub">Each code signs you in once if you lose your authenticator. They are shown only here, and never again.</p>' +
      '<div class="codes">' + codes.map(function(x){ return '<code>'+h(x)+'</code>'; }).join('') + '</div>' +
      '<div class="row" style="margin-top:.5rem">' +
        '<button class="btn" id="bcopy">Copy all</button>' +
        '<button class="btn" id="bdl">Download</button>' +
        '<div style="flex:1"></div>' +
        '<button class="btn pri" id="bdone">I have saved them</button>' +
      '</div>';
    var text = 'Node Portal backup codes\n\n' + codes.join('\n') + '\n';
    $('bcopy').onclick = function(){ navigator.clipboard.writeText(text);
        $('bcopy').textContent = 'Copied'; };
    $('bdl').onclick = function(){
        var a=document.createElement('a');
        a.href = URL.createObjectURL(new Blob([text],{type:'text/plain'}));
        a.download = 'nodeportal-backup-codes.txt'; a.click();
    };
    $('bdone').onclick = function(){ boot(); };
}

function gateLogin(name){
    var c = $('gatecard');
    c.innerHTML =
      '<span class="eyebrow">' + h(name||'Node Portal') + '</span>' +
      '<h1>Sign in</h1>' +
      '<p class="sub">Password and the current six digit code. A backup code works in place of the six digits.</p>' +
      '<div id="gmsg"></div>' +
      '<label class="f"><span>Username</span><input type="text" id="lu" autocomplete="username"></label>' +
      '<label class="f"><span>Password</span><input type="password" id="lp" autocomplete="current-password"></label>' +
      '<label class="f"><span>Code</span><input type="text" id="lc" placeholder="000000" autocomplete="one-time-code"></label>' +
      '<button class="btn pri" id="lgo" style="width:100%">Sign in</button>';
    var go = function(){
        note('gmsg','info','Checking...');
        api('/auth/login', {json:{username:$('lu').value.trim(), password:$('lp').value, code:$('lc').value.trim()}})
        .then(function(r){
            if(!r.ok) { note('gmsg','err',h(r.error)); $('lc').value=''; $('lc').focus(); return; }
            if(r.usedBackup) alert('You used a backup code. '+r.backupRemaining+' remain.');
            boot();
        });
    };
    $('lgo').onclick = go;
    ['lu','lp','lc'].forEach(function(id){
        $(id).addEventListener('keydown', function(e){ if(e.key==='Enter') go(); });
    });
    setTimeout(function(){ $('lu').focus(); }, 30);
}

/* ---------------- tab shell ---------------- */
var TAB_INIT = {};
function showTab(name){
    state.tab = name;
    document.querySelectorAll('nav.rail button').forEach(function(b){
        b.classList.toggle('on', b.dataset.tab===name); });
    document.querySelectorAll('section.pane').forEach(function(p){
        p.classList.toggle('on', p.id==='pane-'+name); });
    if(TAB_INIT[name]) TAB_INIT[name]();
    try{ history.replaceState(null,'','/admin#'+name); }catch(e){}
}
function wireTabs(){
    document.querySelectorAll('nav.rail button').forEach(function(b){
        b.onclick = function(){ showTab(b.dataset.tab); };
    });
    document.addEventListener('keydown', function(e){
        if(e.target && /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) return;
        var map = {'1':'dash','2':'term','3':'caddy','4':'files','5':'shares','6':'api','7':'editor'};
        if(map[e.key]) showTab(map[e.key]);
    });
    $('signout').onclick = function(){
        api('/auth/logout',{method:'POST'}).then(function(){ location.reload(); });
    };
}

function boot(){
    api('/auth/status').then(function(r){
        if(r.mode === 'setup') { $('gate').style.display='grid'; return gateSetup(); }
        if(r.mode === 'login') { $('gate').style.display='grid'; return gateLogin(r.siteName); }
        $('gate').style.display = 'none';
        $('app').classList.add('on');
        $('hname').textContent = r.siteName || 'Node Portal';
        $('huser').textContent = r.user || '';
        document.title = (r.siteName||'Node Portal') + ' admin';
        if(!state.started){ state.started = true; startApp(); }
    });
}
`;

/* ---- client script: dashboard, charts, maintenance ---------------------- */
const ADMIN_JS_DASH = String.raw`
function sparkline(points, color){
    if(!points.length) return '';
    var w=200,hh=34,max=Math.max.apply(null,points.concat([0.0001]));
    var d='', step = points.length>1 ? w/(points.length-1) : w;
    points.forEach(function(v,i){
        var x=i*step, y=hh-(v/max)*(hh-2)-1;
        d += (i?'L':'M')+x.toFixed(1)+' '+y.toFixed(1);
    });
    return '<svg class="spark" viewBox="0 0 '+w+' '+hh+'" preserveAspectRatio="none">'+
        '<path d="'+d+'" fill="none" stroke="'+color+'" stroke-width="1.5"/>'+
        '<path d="'+d+'L'+w+' '+hh+'L0 '+hh+'Z" fill="'+color+'" opacity=".13" stroke="none"/></svg>';
}

function lineChart(host, title, sub, series, hist, fmt, forceMax){
    var W=600, H=130, PL=52, PR=8, PT=10, PB=18;
    if(!hist.length){ host.innerHTML='<h3>'+h(title)+'</h3><div class="empty">Collecting the first sample...</div>'; return; }
    var max = forceMax || 0;
    series.forEach(function(s){ hist.forEach(function(p){
        var v = p[s.key]; if(typeof v==='number' && v>max) max=v; }); });
    if(!max) max = 1;
    max = max * 1.12;
    var n = hist.length;
    var x = function(i){ return PL + (n>1 ? i*(W-PL-PR)/(n-1) : 0); };
    var y = function(v){ return PT + (H-PT-PB) * (1 - (v||0)/max); };

    var g='';
    for(var k=0;k<=3;k++){
        var gv = max*k/3, gy = y(gv);
        g += '<line x1="'+PL+'" x2="'+(W-PR)+'" y1="'+gy.toFixed(1)+'" y2="'+gy.toFixed(1)+
             '" stroke="#1e2532" stroke-width="1"/>' +
             '<text x="'+(PL-6)+'" y="'+(gy+3.5).toFixed(1)+'" text-anchor="end" fill="#4d5769" font-size="9">'+
             h(fmt(gv))+'</text>';
    }
    /* hour ticks */
    var firstT = hist[0].t, lastT = hist[n-1].t;
    g += '<text x="'+PL+'" y="'+(H-5)+'" fill="#4d5769" font-size="9">'+
         h(new Date(firstT).toLocaleTimeString(undefined,{hour:'2-digit',minute:'2-digit'}))+'</text>';
    g += '<text x="'+(W-PR)+'" y="'+(H-5)+'" text-anchor="end" fill="#4d5769" font-size="9">'+
         h(new Date(lastT).toLocaleTimeString(undefined,{hour:'2-digit',minute:'2-digit'}))+'</text>';

    var paths='';
    series.forEach(function(s){
        var d='', started=false;
        hist.forEach(function(p,i){
            var v=p[s.key];
            if(typeof v!=='number'){ return; }
            d += (started?'L':'M')+x(i).toFixed(1)+' '+y(v).toFixed(1); started=true;
        });
        if(!d) return;
        if(s.fill) paths += '<path d="'+d+'L'+x(n-1).toFixed(1)+' '+y(0)+'L'+x(0).toFixed(1)+' '+y(0)+
                            'Z" fill="'+s.color+'" opacity=".10"/>';
        paths += '<path d="'+d+'" fill="none" stroke="'+s.color+'" stroke-width="1.6" '+
                 'stroke-linejoin="round" stroke-linecap="round"/>';
    });
    var legend = series.length>1 ? '<div class="legend">' + series.map(function(s){
        return '<span><i style="background:'+s.color+'"></i>'+h(s.label)+'</span>'; }).join('') + '</div>' : '';
    host.innerHTML = '<h3>'+h(title)+(sub?'<em>'+h(sub)+'</em>':'')+'</h3>' +
        '<svg viewBox="0 0 '+W+' '+H+'" preserveAspectRatio="none">'+g+paths+'</svg>' + legend;
}

function renderDash(d){
    state.overview = d;
    var live = d.live, hist = d.history || [];

    $('hhost').textContent = live.hostname;
    $('hup').textContent = 'up ' + dur(live.uptime);
    $('hload').textContent = 'load ' + live.load.join(' ');
    $('hdot').className = 'dot' + (live.cpu > 92 ? ' bad' : '');

    var memPct = live.mem.total ? (live.mem.used/live.mem.total*100) : 0;
    var rootDisk = (live.disks||[]).filter(function(x){ return x.mount==='/'; })[0] || (live.disks||[])[0];
    var diskPct = rootDisk ? rootDisk.used/rootDisk.total*100 : 0;

    $('cards').innerHTML =
      card('Processor', live.cpu.toFixed(0)+'%', live.cores+' cores'+(live.temp?'  '+live.temp.toFixed(0)+'&deg;C':''),
           sparkline(hist.map(function(p){return p.cpu;}), '#4ec9d4')) +
      card('Memory', memPct.toFixed(0)+'%', bytes(live.mem.used)+' of '+bytes(live.mem.total),
           sparkline(hist.map(function(p){return p.memUsed;}), '#a68cf0')) +
      card('Network', rate(live.netRx+live.netTx), '&#8595; '+rate(live.netRx)+'   &#8593; '+rate(live.netTx),
           sparkline(hist.map(function(p){return p.netRx+p.netTx;}), '#48b884')) +
      card('Disk I/O', rate(live.dskRd+live.dskWr), (rootDisk? diskPct.toFixed(0)+'% of '+rootDisk.mount+' used':''),
           sparkline(hist.map(function(p){return p.dskRd+p.dskWr;}), '#e8a33d'));

    lineChart($('c-cpu'), 'Processor', 'last hour, one sample a minute',
        [{key:'cpu',color:'#4ec9d4',label:'CPU %',fill:true}], hist,
        function(v){ return v.toFixed(0)+'%'; }, 100);
    lineChart($('c-mem'), 'Memory', bytes(live.mem.total)+' total',
        [{key:'memUsed',color:'#a68cf0',label:'used',fill:true},
         {key:'swapUsed',color:'#e07b9a',label:'swap'}], hist, bytes,
        live.mem.total);
    lineChart($('c-net'), 'Network', 'all interfaces except loopback',
        [{key:'netRx',color:'#48b884',label:'in'},{key:'netTx',color:'#e8a33d',label:'out'}],
        hist, rate);
    lineChart($('c-disk'), 'Disk throughput', 'physical devices',
        [{key:'dskRd',color:'#4ec9d4',label:'read'},{key:'dskWr',color:'#e5624c',label:'write'}],
        hist, rate);

    $('sysinfo').innerHTML = [
        ['Host', live.hostname],
        ['System', live.platform + '  ' + live.arch],
        ['CPU', live.cpuModel + '  (' + live.cores + ' x ' + live.cpuSpeed + ' MHz)'],
        ['Load average', live.load.join('   ')],
        ['Temperature', live.temp ? live.temp.toFixed(1)+' C' : 'not reported'],
        ['Uptime', dur(live.uptime)],
        ['Node', live.node],
        ['Portal uptime', dur(live.procUptime) + '   ' + bytes(live.procMem) + ' rss'],
        ['Portal service', d.service.active + ', ' + d.service.enabled],
        ['Caddy', d.caddy.installed ? (d.caddy.active + ', ' + d.caddy.enabled) : 'not installed'],
        ['Server folder', d.serverDir],
        ['Shares', d.shares + ' active,  ' + d.endpoints + ' endpoints']
    ].map(function(r){ return '<tr><td>'+h(r[0])+'</td><td>'+h(r[1])+'</td></tr>'; }).join('');

    $('disks').innerHTML = (live.disks||[]).map(function(dk){
        var pct = dk.total ? dk.used/dk.total*100 : 0;
        var cls = pct>90?'hot':(pct>75?'warn':'');
        return '<div class="usage"><div class="t"><b>'+h(dk.mount)+'</b>'+
            '<span>'+bytes(dk.used)+' / '+bytes(dk.total)+'  ('+pct.toFixed(0)+'%)</span></div>'+
            '<div class="track"><i class="'+cls+'" style="width:'+pct.toFixed(1)+'%"></i></div></div>';
    }).join('') || '<div class="empty">No mounted filesystems reported</div>';

    if(!$('mbtns').dataset.done){
        $('mbtns').dataset.done = '1';
        $('mbtns').innerHTML = (d.maintenance||[]).map(function(m){
            var danger = /reboot|shut/.test(m.key) ? ' danger' : '';
            return '<button class="btn sm'+danger+'" data-job="'+h(m.key)+'">'+h(m.label)+'</button>';
        }).join('');
    }
    if(d.updateReport){
        note('updnote', d.updateReport.ok?'ok':'err',
            h(d.updateReport.message) + (d.updateReport.detail ?
            '<pre class="out" style="max-height:12rem">'+h(d.updateReport.detail)+'</pre>' : ''));
    }
}
function card(lab, big, sub, spark){
    return '<div class="stat"><div class="lab">'+h(lab)+'</div><div class="big">'+big+
           '</div><div class="sub">'+sub+'</div>'+spark+'</div>';
}

function loadDash(){
    api('/api/overview').then(function(r){ if(r.ok) renderDash(r); });
}

/* ---- maintenance jobs over a websocket ---- */
function runJob(job){
    var out = $('mout');
    out.style.display='block';
    out.textContent = '';
    var proto = location.protocol==='https:'?'wss://':'ws://';
    var ws = new WebSocket(proto + location.host + '/admin/ws/exec?job=' + encodeURIComponent(job));
    ws.onmessage = function(ev){
        var m; try{ m=JSON.parse(ev.data); }catch(e){ return; }
        if(m.type==='start') out.textContent += '$ ' + m.label + '\n';
        if(m.type==='out')   out.textContent += m.data;
        if(m.type==='end')   out.textContent += '\n[finished, exit ' + m.code + ']\n';
        out.scrollTop = out.scrollHeight;
    };
    ws.onerror = function(){ out.textContent += '\n[connection failed]\n'; };
    ws.onclose  = function(){ setTimeout(loadDash, 2500); };
}
document.addEventListener('click', function(e){
    var b = e.target.closest ? e.target.closest('[data-job]') : null;
    if(!b) return;
    var job = b.dataset.job;
    if(/reboot|shut/.test(job) && !confirm('Really ' + b.textContent.toLowerCase() + '?')) return;
    if(job === 'restart-node' && !confirm('Restart the portal? This page will reconnect in a few seconds.')) return;
    runJob(job);
});
TAB_INIT.dash = loadDash;
`;

/* ---- client script: file manager --------------------------------------- */
const ADMIN_JS_FILES = String.raw`
function modal(html, cls){
    $('modalbox').className = 'box' + (cls?' '+cls:'');
    $('modalbox').innerHTML = html;
    $('modal').classList.add('on');
}
function closeModal(){ $('modal').classList.remove('on'); $('modalbox').innerHTML=''; }
$('modal').addEventListener('click', function(e){ if(e.target === $('modal')) closeModal(); });
document.addEventListener('keydown', function(e){ if(e.key==='Escape') closeModal(); });

function loadFiles(p){
    var target = p || state.path || (state.overview ? state.overview.serverDir : '/');
    api('/api/files/list?path=' + encodeURIComponent(target)).then(function(r){
        if(!r.ok){ note('filemsg','err',h(r.error)); return; }
        state.path = r.path; state.files = r.items; state.sel = {};
        $('f-all').checked = false;
        $('crumbs').innerHTML = r.crumbs.map(function(c){
            return '<a data-p="'+h(c.path)+'">'+h(c.name)+'</a>';
        }).join('<s>/</s>');
        $('crumbs').querySelectorAll('a').forEach(function(a){
            a.onclick = function(){ loadFiles(a.dataset.p); };
        });
        renderFiles();
        note('filemsg','');
    });
}
function renderFiles(){
    var rows = state.files.map(function(it, i){
        var full = state.path.replace(/\/$/,'') + '/' + it.name;
        return '<tr data-i="'+i+'">' +
          '<td><input type="checkbox" class="cb" data-p="'+h(full)+'"></td>' +
          '<td><span class="nm" data-open="'+h(full)+'" data-dir="'+(it.dir?1:0)+'" data-text="'+(it.text?1:0)+'">' +
            '<span class="ic'+(it.dir?' d':'')+'">'+(it.dir?'&#9698;':(it.link?'&#8599;':'&#183;'))+'</span>' +
            h(it.name) + (it.link ? '<span style="color:var(--faint);font-size:.72rem"> &rarr; '+h(it.link)+'</span>' : '') +
          '</span></td>' +
          '<td class="r">'+(it.dir?'':bytes(it.size))+'</td>' +
          '<td class="r">'+h(when(it.mtime))+'</td>' +
          '<td class="r">'+h(it.mode)+'</td>' +
          '<td class="acts">' +
            (it.text||it.dir?'':'<button data-view="'+h(full)+'">view</button>') +
            (it.text?'<button data-edit="'+h(full)+'">edit</button>':'') +
            '<button data-dl="'+h(full)+'">get</button>' +
            '<button data-share="'+h(full)+'">share</button>' +
            '<button data-ren="'+h(full)+'" data-name="'+h(it.name)+'">rename</button>' +
          '</td></tr>';
    }).join('');
    $('filerows').innerHTML = rows || '<tr><td colspan="6" class="empty">This folder is empty. Drop files anywhere to upload.</td></tr>';

    $('filerows').querySelectorAll('.nm').forEach(function(n){
        n.onclick = function(){
            if(n.dataset.dir==='1') loadFiles(n.dataset.open);
            else if(n.dataset.text==='1') openEditor(n.dataset.open);
            else window.open('/admin/api/files/raw?path='+encodeURIComponent(n.dataset.open),'_blank');
        };
    });
    $('filerows').querySelectorAll('[data-edit]').forEach(function(b){
        b.onclick = function(){ openEditor(b.dataset.edit); }; });
    $('filerows').querySelectorAll('[data-view]').forEach(function(b){
        b.onclick = function(){ window.open('/admin/api/files/raw?path='+encodeURIComponent(b.dataset.view),'_blank'); }; });
    $('filerows').querySelectorAll('[data-dl]').forEach(function(b){
        b.onclick = function(){ location.href='/admin/api/files/download?path='+encodeURIComponent(b.dataset.dl); }; });
    $('filerows').querySelectorAll('[data-share]').forEach(function(b){
        b.onclick = function(){ shareDialog(b.dataset.share); }; });
    $('filerows').querySelectorAll('[data-ren]').forEach(function(b){
        b.onclick = function(){
            var n = prompt('New name', b.dataset.name);
            if(!n || n===b.dataset.name) return;
            api('/api/files/rename',{json:{path:b.dataset.ren, name:n}}).then(function(r){
                if(!r.ok) return note('filemsg','err',h(r.error));
                loadFiles();
            });
        };
    });
    $('filerows').querySelectorAll('.cb').forEach(function(cb){
        cb.onchange = function(){
            if(cb.checked) state.sel[cb.dataset.p]=1; else delete state.sel[cb.dataset.p];
        };
    });
}
function selected(){ return Object.keys(state.sel); }

function openEditor(p){
    api('/api/files/read?path='+encodeURIComponent(p)).then(function(r){
        if(!r.ok) return note('filemsg','err',h(r.error));
        var name = p.split('/').pop();
        modal(
          '<header><h3>'+h(p)+'</h3>' +
            '<span class="pill" id="fe-st">'+bytes(r.size)+'</span>' +
            '<button class="x" onclick="closeModal()">&times;</button></header>' +
          '<div class="body" style="padding:.6rem">' +
            '<div class="editwrap" style="height:60vh">' +
              '<div class="gutter" id="fe-g"></div>' +
              '<div class="codebox"><pre id="fe-h"></pre><textarea id="fe-t" spellcheck="false"></textarea></div>' +
            '</div>' +
          '</div>' +
          '<footer><span style="color:var(--faint);font-size:.75rem">4 space indent &middot; Ctrl+S saves</span>' +
            '<div class="sp"></div>' +
            '<button class="btn" onclick="closeModal()">Close</button>' +
            '<button class="btn pri" id="fe-save">Save</button></footer>');
        var ed = bindEditor('fe-t','fe-h','fe-g', function(src){ return hlAuto(src, name); });
        ed.set(r.content);
        var save = function(){
            $('fe-st').textContent = 'Saving...';
            api('/api/files/write',{json:{path:p, content:ed.get()}}).then(function(w){
                $('fe-st').textContent = w.ok ? 'Saved '+new Date().toLocaleTimeString() : 'Failed';
                if(!w.ok) alert(w.error);
                else loadFiles();
            });
        };
        $('fe-save').onclick = save;
        ed.ta.addEventListener('editor-save', save);
    });
}

function shareDialog(p){
    modal(
      '<header><h3>Share</h3><button class="x" onclick="closeModal()">&times;</button></header>' +
      '<div class="body">' +
        '<p class="hint" style="margin:0 0 .9rem">'+h(p)+'</p>' +
        '<label class="f"><span>Label</span><input type="text" id="sh-label" value="'+h(p.split('/').pop())+'"></label>' +
        '<label class="f"><span>Access</span><select id="sh-mode">' +
          '<option value="read">Read only &mdash; visitors download</option>' +
          '<option value="edit">Edit &mdash; visitors can change and upload</option>' +
        '</select></label>' +
        '<label class="f"><span>Expires</span><select id="sh-exp">' +
          '<option value="0">Never</option><option value="3600">In 1 hour</option>' +
          '<option value="86400">In 1 day</option><option value="604800">In 7 days</option>' +
          '<option value="2592000">In 30 days</option></select></label>' +
        '<div id="sh-result"></div>' +
      '</div>' +
      '<footer><div class="sp"></div><button class="btn" onclick="closeModal()">Close</button>' +
        '<button class="btn pri" id="sh-make">Create link</button></footer>', 'narrow');
    $('sh-make').onclick = function(){
        api('/api/shares/create',{json:{
            path:p, label:$('sh-label').value, mode:$('sh-mode').value,
            expiresIn: Number($('sh-exp').value)||0 }}).then(function(r){
            if(!r.ok) return note('sh-result','err',h(r.error));
            var link = location.origin + '/s/' + r.token;
            note('sh-result','ok','Link created.<div class="link" style="margin-top:.4rem">'+h(link)+'</div>');
            navigator.clipboard.writeText(link).catch(function(){});
            $('sh-make').textContent = 'Copied to clipboard';
            $('sh-make').disabled = true;
        });
    };
}

/* ---- upload: files and whole folders ---- */
function uploadOne(file, relPath){
    return fetch('/admin/api/files/upload', {
        method:'POST',
        headers:{'X-Np':'1',
                 'X-Np-Path': btoa(unescape(encodeURIComponent(relPath))),
                 'X-Np-Dir' : btoa(unescape(encodeURIComponent(state.path)))},
        body:file
    }).then(function(r){ return r.json(); });
}
function walkEntry(entry, prefix, acc){
    return new Promise(function(resolve){
        if(entry.isFile){
            entry.file(function(f){ acc.push({file:f, rel:prefix+f.name}); resolve(); });
        } else if(entry.isDirectory){
            var rd = entry.createReader(); var all=[];
            var readMore = function(){
                rd.readEntries(function(ents){
                    if(!ents.length){
                        Promise.all(all.map(function(e){ return walkEntry(e, prefix+entry.name+'/', acc); }))
                            .then(resolve);
                        return;
                    }
                    all = all.concat(Array.prototype.slice.call(ents));
                    readMore();
                }, function(){ resolve(); });
            };
            readMore();
        } else resolve();
    });
}
async function doUpload(items){
    var total = items.length, done = 0, failed = 0;
    note('filemsg','info','Uploading 0 of '+total+'...');
    for(var i=0;i<items.length;i++){
        try{
            var r = await uploadOne(items[i].file, items[i].rel);
            if(!r.ok) failed++;
        }catch(e){ failed++; }
        done++;
        note('filemsg','info','Uploading '+done+' of '+total+'...');
    }
    note('filemsg', failed?'err':'ok',
        failed ? (failed+' of '+total+' uploads failed') : (total+' uploaded'));
    setTimeout(function(){ note('filemsg',''); }, 3500);
    loadFiles();
}

function wireFiles(){
    $('f-refresh').onclick = function(){ loadFiles(); };
    $('f-up').onclick   = function(){ loadFiles(state.path.replace(/\/[^/]*$/,'') || '/'); };
    $('f-home').onclick = function(){ loadFiles(state.overview ? state.overview.serverDir : '/'); };
    $('f-root').onclick = function(){ loadFiles('/'); };
    $('f-all').onchange = function(){
        var on = $('f-all').checked;
        $('filerows').querySelectorAll('.cb').forEach(function(cb){
            cb.checked = on;
            if(on) state.sel[cb.dataset.p]=1; else delete state.sel[cb.dataset.p];
        });
    };
    $('f-newdir').onclick = function(){
        var n = prompt('Folder name'); if(!n) return;
        api('/api/files/mkdir',{json:{path:state.path, name:n}}).then(function(r){
            if(!r.ok) return note('filemsg','err',h(r.error)); loadFiles(); });
    };
    $('f-newfile').onclick = function(){
        var n = prompt('File name','untitled.txt'); if(!n) return;
        api('/api/files/newfile',{json:{path:state.path, name:n}}).then(function(r){
            if(!r.ok) return note('filemsg','err',h(r.error));
            loadFiles(); setTimeout(function(){ openEditor(r.path); }, 250); });
    };
    $('f-upload').onclick = function(){ $('f-input').click(); };
    $('f-input').onchange = function(){
        var items = Array.prototype.map.call($('f-input').files, function(f){
            return {file:f, rel:f.webkitRelativePath || f.name}; });
        $('f-input').value=''; if(items.length) doUpload(items);
    };
    $('f-zip').onclick = function(){
        var sel = selected();
        if(sel.length) location.href = '/admin/api/files/zip?paths=' +
            encodeURIComponent(btoa(unescape(encodeURIComponent(JSON.stringify(sel)))));
        else location.href = '/admin/api/files/zip?path=' + encodeURIComponent(state.path);
    };
    $('f-del').onclick = function(){
        var sel = selected();
        if(!sel.length) return note('filemsg','err','Tick something to delete first.');
        if(!confirm('Delete these ' + sel.length + ' items?\n\n' + sel.slice(0,12).join('\n') +
            (sel.length>12?'\n...':'') + '\n\nThis cannot be undone.')) return;
        api('/api/files/delete',{json:{paths:sel}}).then(function(r){
            if(!r.ok) note('filemsg','err','Some items could not be deleted: ' +
                h(r.failed.map(function(f){return f.path+' ('+f.error+')';}).join(', ')));
            else toast(r.deleted + ' deleted');
            loadFiles();
        });
    };

    /* drag and drop anywhere in the app */
    var depth = 0;
    window.addEventListener('dragenter', function(e){
        e.preventDefault(); depth++;
        if(state.tab==='files') $('drop').classList.add('on');
    });
    window.addEventListener('dragleave', function(e){
        e.preventDefault(); depth--; if(depth<=0){ depth=0; $('drop').classList.remove('on'); }
    });
    window.addEventListener('dragover', function(e){ e.preventDefault(); });
    window.addEventListener('drop', function(e){
        e.preventDefault(); depth=0; $('drop').classList.remove('on');
        if(state.tab!=='files') return;
        var dt = e.dataTransfer, acc = [];
        if(dt.items && dt.items.length && dt.items[0].webkitGetAsEntry){
            var entries = [];
            for(var i=0;i<dt.items.length;i++){
                var en = dt.items[i].webkitGetAsEntry();
                if(en) entries.push(en);
            }
            Promise.all(entries.map(function(en){ return walkEntry(en, '', acc); }))
                .then(function(){ if(acc.length) doUpload(acc); });
        } else if(dt.files && dt.files.length){
            for(var j=0;j<dt.files.length;j++) acc.push({file:dt.files[j], rel:dt.files[j].name});
            doUpload(acc);
        }
    });
}
TAB_INIT.files = function(){ if(!state.path) loadFiles(); };
`;

/* ---- client script: shares, Caddy, server.js editor --------------------- */
const ADMIN_JS_MISC = String.raw`
/* ---------------- shares ---------------- */
function loadShares(){
    api('/api/shares').then(function(r){
        if(!r.ok) return;
        $('sharerows').innerHTML = r.shares.map(function(s){
            var link = location.origin + '/s/' + s.token;
            var badge = s.expired ? '<span class="pill dead">expired</span>'
                      : '<span class="pill live">live</span>';
            return '<tr>' +
              '<td><b style="font-weight:500">'+h(s.label)+'</b>' + (s.exists?'':' <span class="pill dead">missing</span>') +
                '<div style="color:var(--faint);font-size:.72rem">'+h(s.path)+'</div></td>' +
              '<td><span class="link">'+h(link)+'</span></td>' +
              '<td><span class="pill '+(s.mode==='edit'?'edit':'read')+'">'+h(s.mode)+'</span></td>' +
              '<td>'+badge+' '+(s.expires?h(when(s.expires)):'never')+'</td>' +
              '<td class="r">'+(s.hits||0)+'</td>' +
              '<td class="acts">' +
                '<button data-copy="'+h(link)+'">copy</button>' +
                '<button data-open="'+h(link)+'">open</button>' +
                '<button data-mode="'+h(s.token)+'" data-cur="'+h(s.mode)+'">'+
                  (s.mode==='edit'?'make read':'allow edit')+'</button>' +
                '<button data-rev="'+h(s.token)+'">revoke</button>' +
              '</td></tr>';
        }).join('') || '<tr><td colspan="6" class="empty">No shares yet. Use the share button in Files.</td></tr>';

        $('sharerows').querySelectorAll('[data-copy]').forEach(function(b){
            b.onclick = function(){ navigator.clipboard.writeText(b.dataset.copy);
                b.textContent='copied'; setTimeout(function(){b.textContent='copy';},1200); }; });
        $('sharerows').querySelectorAll('[data-open]').forEach(function(b){
            b.onclick = function(){ window.open(b.dataset.open,'_blank'); }; });
        $('sharerows').querySelectorAll('[data-mode]').forEach(function(b){
            b.onclick = function(){
                api('/api/shares/update',{json:{token:b.dataset.mode,
                    mode: b.dataset.cur==='edit'?'read':'edit'}}).then(loadShares); }; });
        $('sharerows').querySelectorAll('[data-rev]').forEach(function(b){
            b.onclick = function(){
                if(!confirm('Revoke this link? Anyone holding it loses access immediately.')) return;
                api('/api/shares/delete',{json:{token:b.dataset.rev}}).then(loadShares); }; });
    });
}
function wireShares(){
    $('sh-refresh').onclick = loadShares;
    $('sh-purge').onclick = function(){
        api('/api/shares').then(function(r){
            var dead = r.shares.filter(function(s){ return s.expired || !s.exists; })
                               .map(function(s){ return s.token; });
            if(!dead.length) return alert('Nothing to clear.');
            if(!confirm('Remove ' + dead.length + ' expired or broken shares?')) return;
            api('/api/shares/delete',{json:{tokens:dead}}).then(loadShares);
        });
    };
}
TAB_INIT.shares = loadShares;

/* ---------------- caddy ---------------- */
var caddyEd = null;
function loadCaddy(){
    api('/api/caddy').then(function(r){
        if(!r.ok) return;
        if(!caddyEd) caddyEd = bindEditor('caddy-t','caddy-h','caddy-g', hlCaddy);
        if(!caddyEd.dirty) caddyEd.set(r.config);
        var st = r.status;
        $('caddystat').innerHTML = [
            ['Installed', st.installed ? 'yes' : 'no'],
            ['Running', st.active || 'unknown'],
            ['Starts on boot', st.enabled || 'unknown'],
            ['Version', st.version || '-'],
            ['Active since', st.since || '-'],
            ['Config file', st.configPath]
        ].map(function(x){ return '<tr><td>'+h(x[0])+'</td><td>'+h(x[1])+'</td></tr>'; }).join('');
        $('nodestat').innerHTML = [
            ['Running', r.service.active],
            ['Starts on boot', r.service.enabled],
            ['Active since', r.service.since || '-'],
            ['Process', 'pid ' + r.service.pid + '  ' + r.service.node],
            ['Listening on', 'http://0.0.0.0:' + location.port]
        ].map(function(x){ return '<tr><td>'+h(x[0])+'</td><td>'+h(x[1])+'</td></tr>'; }).join('');
        $('caddybk').innerHTML = '<option value="">Backups (' + r.backups.length + ')</option>' +
            r.backups.map(function(b){
                return '<option value="'+h(b.name)+'">'+h(when(b.mtime))+'  ('+bytes(b.size)+')</option>';
            }).join('');
        $('caddylog').textContent = r.recentLog || 'no log output';
    });
}
function wireCaddy(){
    $('caddysave').onclick = function(){
        note('caddymsg','info','Validating...');
        $('caddysave').disabled = true;
        api('/api/caddy/save',{json:{config: caddyEd.get()}}).then(function(r){
            $('caddysave').disabled = false;
            caddyEd.dirty = false;
            if(!r.ok) return note('caddymsg','err', h(r.message||r.error) +
                (r.detail?'<pre class="out">'+h(r.detail)+'</pre>':''));
            note('caddymsg','ok','Applied and reloaded. Previous config saved as ' + h(r.backup||'a backup') + '.');
            loadCaddy();
        });
    };
    $('caddyrevert').onclick = function(){
        var n = $('caddybk').value; if(!n) return;
        api('/api/backups/read?what=caddy&name='+encodeURIComponent(n)).then(function(r){
            if(!r.ok) return note('caddymsg','err',h(r.error));
            caddyEd.set(r.content); caddyEd.dirty = true;
            note('caddymsg','info','Backup loaded into the editor. Apply it to make it live.');
        });
    };
    $('caddyinstall').onclick = function(){
        if(!confirm('Install Caddy from the official apt repository?')) return;
        api('/api/caddy/install',{method:'POST'}).then(function(r){
            note('caddymsg','info',h(r.message||'Installing...'));
            setTimeout(loadCaddy, 8000);
        });
    };
    document.addEventListener('input', function(e){
        if(e.target && e.target.id==='caddy-t' && caddyEd) caddyEd.dirty = true;
    });
}
TAB_INIT.caddy = loadCaddy;

/* ---------------- server.js editor ---------------- */
var srcEd = null, srcOriginal = '';
function loadSource(force){
    api('/api/source').then(function(r){
        if(!r.ok) return;
        if(!srcEd){
            srcEd = bindEditor('ed-t','ed-h','ed-g', hlJS);
            srcEd.ta.addEventListener('editor-save', function(){ $('ed-save').click(); });
        }
        if(force || !srcEd.dirty){ srcEd.set(r.source); srcOriginal = r.source; srcEd.dirty=false; }
        $('ed-path').textContent = r.path;
        $('ed-bk').innerHTML = '<option value="">Backups (' + r.backups.length + ')</option>' +
            r.backups.map(function(b){
                return '<option value="'+h(b.name)+'">'+h(when(b.mtime))+'  ('+bytes(b.size)+')</option>';
            }).join('');
    });
}
function wireEditor(){
    document.addEventListener('input', function(e){
        if(e.target && e.target.id==='ed-t' && srcEd) srcEd.dirty = true;
    });
    $('ed-reload').onclick = function(){
        if(srcEd.dirty && !confirm('Throw away your changes?')) return;
        loadSource(true); note('edmsg','');
    };
    $('ed-load').onclick = function(){
        var n = $('ed-bk').value; if(!n) return;
        api('/api/backups/read?what=server&name='+encodeURIComponent(n)).then(function(r){
            if(!r.ok) return note('edmsg','err',h(r.error));
            srcEd.set(r.content); srcEd.dirty = true;
            note('edmsg','info','Backup loaded into the editor. Apply it to make it live.');
        });
    };
    $('ed-save').onclick = function(){
        if(srcEd.get() === srcOriginal) return note('edmsg','info','Nothing has changed.');
        if(!confirm('Check and apply this server.js? The portal restarts if it passes.')) return;
        note('edmsg','info','Checking syntax, then boot testing the new file...');
        $('ed-save').disabled = true;
        api('/api/source/update',{json:{source: srcEd.get()}}).then(function(r){
            $('ed-save').disabled = false;
            if(!r.ok) return note('edmsg','err', h(r.message||r.error) +
                (r.detail?'<pre class="out">'+h(r.detail)+'</pre>':''));
            srcEd.dirty = false;
            note('edmsg','ok','Passed. Previous version saved as ' + h(r.backup||'a backup') +
                '. Restarting now &mdash; this page will reconnect on its own.');
            waitForRestart();
        }).catch(function(){ $('ed-save').disabled = false; });
    };
}
function waitForRestart(){
    var tries = 0;
    var poll = setInterval(function(){
        tries++;
        fetch('/admin/auth/status', {cache:'no-store'}).then(function(r){ return r.json(); })
        .then(function(){
            clearInterval(poll);
            note('edmsg','ok','Back up. Reloading...');
            setTimeout(function(){ location.reload(); }, 700);
        }).catch(function(){
            if(tries > 40){ clearInterval(poll);
                note('edmsg','err','The portal has not come back after 80 seconds. ' +
                    'If the new build crashed it rolls back on its own; check the server with ' +
                    'journalctl -u nodeportal -n 50'); }
        });
    }, 2000);
}
TAB_INIT.editor = function(){ loadSource(false); };
`;

/* ---- client script: custom API endpoints -------------------------------- */
const ADMIN_JS_API = String.raw`
var apiEd = null;
var METHODS = ['GET','POST','PUT','PATCH','DELETE','ANY'];
var EVENTS = [];
var STARTER = [
    '// ctx.query, ctx.body, ctx.headers, ctx.method, ctx.ip',
    '// ctx.log(...) writes to the log below',
    '// ctx.store keeps values between runs',
    '// return an object to send JSON, or a string to send HTML',
    '',
    'ctx.log("called via", ctx.trigger);',
    '',
    'return { ok: true, now: new Date().toISOString() };'
].join('\n');

function blankApi(){
    return { id:null, name:'', path:'/api/', methods:['GET'], enabled:true, public:false,
             schedule:'0 3 * * *', scheduleOn:false, events:[], code:STARTER, logs:[] };
}
function loadApis(keepSel){
    api('/api/endpoints').then(function(r){
        if(!r.ok) return;
        state.apis = r.endpoints; EVENTS = r.events;
        renderApiList();
        if(!keepSel){
            if(!state.curApi) selectApi(state.apis[0] || blankApi());
        }
    });
}
function renderApiList(){
    $('apilist').innerHTML = state.apis.map(function(e){
        var on = state.curApi && state.curApi.id === e.id;
        return '<button data-id="'+h(e.id)+'" class="'+(on?'on':'')+'">' +
            '<b>'+h(e.name||'Untitled')+(e.enabled?'':' &middot; off')+'</b>' +
            '<small>'+h(e.path)+'  '+h((e.methods||[]).join(' '))+'</small></button>';
    }).join('') || '<div class="empty" style="padding:1rem">No endpoints yet</div>';
    $('apilist').querySelectorAll('button').forEach(function(b){
        b.onclick = function(){
            var e = state.apis.filter(function(x){ return x.id===b.dataset.id; })[0];
            if(e) selectApi(JSON.parse(JSON.stringify(e)));
        };
    });
}
function selectApi(e){
    state.curApi = e;
    $('a-name').value = e.name || '';
    $('a-path').value = e.path || '/api/';
    $('a-sched').value = e.schedule || '';
    $('a-methods').innerHTML = METHODS.map(function(m){
        return '<span class="chip'+((e.methods||[]).indexOf(m)>=0?' on':'')+'" data-m="'+m+'">'+m+'</span>';
    }).join('');
    $('a-events').innerHTML = EVENTS.map(function(v){
        return '<span class="chip'+((e.events||[]).indexOf(v)>=0?' on':'')+'" data-e="'+h(v)+'">'+h(v)+'</span>';
    }).join('');
    $('a-enabled').classList.toggle('on', e.enabled !== false);
    $('a-public').classList.toggle('on', !!e.public);
    $('a-schedon').classList.toggle('on', !!e.scheduleOn);
    describeSched();
    if(!apiEd) apiEd = bindEditor('api-t','api-h','api-g', hlJS);
    apiEd.set(e.code || STARTER);
    renderApiList();
    renderApiLogs(e.logs || []);
    note('apimsg','');

    $('a-methods').querySelectorAll('.chip').forEach(function(c){
        c.onclick = function(){ c.classList.toggle('on'); }; });
    $('a-events').querySelectorAll('.chip').forEach(function(c){
        c.onclick = function(){ c.classList.toggle('on'); }; });
}
function describeSched(){
    var v = $('a-sched').value.trim();
    var f = v.split(/\s+/);
    $('a-schedtxt').textContent = f.length===5
        ? 'minute hour day month weekday' : 'five fields: minute hour day month weekday';
}
function gatherApi(){
    var methods = [];
    $('a-methods').querySelectorAll('.chip.on').forEach(function(c){ methods.push(c.dataset.m); });
    var events = [];
    $('a-events').querySelectorAll('.chip.on').forEach(function(c){ events.push(c.dataset.e); });
    return {
        id: state.curApi ? state.curApi.id : null,
        name: $('a-name').value.trim(),
        path: $('a-path').value.trim(),
        methods: methods.length?methods:['GET'],
        enabled: $('a-enabled').classList.contains('on'),
        public : $('a-public').classList.contains('on'),
        schedule: $('a-sched').value.trim(),
        scheduleOn: $('a-schedon').classList.contains('on'),
        events: events,
        code: apiEd.get()
    };
}
function renderApiLogs(logs){
    var out = $('apiout');
    if(!logs || !logs.length){ out.style.display='none'; return; }
    out.style.display='block';
    out.textContent = logs.slice(-40).map(function(l){
        return new Date(l.t).toLocaleTimeString() + '  ' + l.level + '  ' + l.msg;
    }).join('\n');
    out.scrollTop = out.scrollHeight;
}
function wireApi(){
    $('a-sched').addEventListener('input', describeSched);
    ['a-enabled','a-public','a-schedon'].forEach(function(id){
        $(id).onclick = function(){ $(id).classList.toggle('on'); };
    });
    $('a-new').onclick = function(){ selectApi(blankApi()); $('a-name').focus(); };
    $('a-save').onclick = function(){
        var d = gatherApi();
        note('apimsg','info','Saving...');
        api('/api/endpoints/save',{json:d}).then(function(r){
            if(!r.ok) return note('apimsg','err',h(r.error));
            state.curApi = r.endpoint;
            note('apimsg','ok','Saved. Live at ' + h(r.endpoint.path) + '.');
            loadApis(true);
            setTimeout(function(){ note('apimsg',''); }, 4000);
        });
    };
    $('a-run').onclick = function(){
        if(!state.curApi || !state.curApi.id) return note('apimsg','err','Save the endpoint first.');
        note('apimsg','info','Running...');
        api('/api/endpoints/run',{json:{id: state.curApi.id}}).then(function(r){
            note('apimsg', r.ok?'ok':'err',
                r.ok ? ('Ran in ' + r.ms + ' ms. Result: ' + h(JSON.stringify(r.result)).slice(0,400))
                     : ('<pre class="out">'+h(r.error)+'</pre>'));
            renderApiLogs(r.endpointLogs||[]);
        });
    };
    $('a-del').onclick = function(){
        if(!state.curApi || !state.curApi.id) return;
        if(!confirm('Delete the endpoint ' + (state.curApi.name||state.curApi.path) + '?')) return;
        api('/api/endpoints/delete',{json:{id: state.curApi.id}}).then(function(){
            state.curApi = null; loadApis(false);
        });
    };
}
TAB_INIT.api = function(){ loadApis(!!state.curApi); };
`;

/* ---- client script: terminal emulator ---------------------------------- */
const ADMIN_JS_TERM = String.raw`
var PAL = (function(){
    var p = ['#0e1117','#e5624c','#48b884','#e8a33d','#5b9dd9','#a68cf0','#4ec9d4','#c3cbd8',
             '#5a6577','#ff7f6a','#66d6a0','#ffc266','#7ab8ee','#c2aaff','#7fe3ec','#eef2f7'];
    for(var i=0;i<216;i++){
        var r=Math.floor(i/36), g=Math.floor(i/6)%6, b=i%6;
        var f=function(v){ return v?55+v*40:0; };
        p.push('rgb('+f(r)+','+f(g)+','+f(b)+')');
    }
    for(var j=0;j<24;j++){ var v=8+j*10; p.push('rgb('+v+','+v+','+v+')'); }
    return p;
})();
var DEF = { fg:-1, bg:-1, bold:false, ul:false, inv:false, dim:false };

function Term(el){
    this.el = el; this.cols = 100; this.rows = 30;
    this.cx = 0; this.cy = 0;
    this.attr = Object.assign({}, DEF);
    this.saved = null;
    this.scroll = [];            /* scrollback */
    this.st = 0;                 /* parser state */
    this.pbuf = '';
    this.top = 0; this.bot = 29;
    this.wrapNext = false;
    this.buf = [];
    this.reset();
}
Term.prototype.blankRow = function(){
    var r = [];
    for(var i=0;i<this.cols;i++) r.push([' ', Object.assign({}, DEF)]);
    return r;
};
Term.prototype.reset = function(){
    this.buf = [];
    for(var y=0;y<this.rows;y++) this.buf.push(this.blankRow());
    this.cx=0; this.cy=0; this.top=0; this.bot=this.rows-1;
    this.attr = Object.assign({}, DEF);
};
Term.prototype.resize = function(cols, rows){
    if(cols===this.cols && rows===this.rows) return;
    this.cols = Math.max(20, cols); this.rows = Math.max(5, rows);
    var old = this.buf;
    this.buf = [];
    for(var y=0;y<this.rows;y++){
        if(old[y]){
            var r = old[y].slice(0, this.cols);
            while(r.length < this.cols) r.push([' ', Object.assign({}, DEF)]);
            this.buf.push(r);
        } else this.buf.push(this.blankRow());
    }
    this.top = 0; this.bot = this.rows-1;
    this.cy = Math.min(this.cy, this.rows-1);
    this.cx = Math.min(this.cx, this.cols-1);
};
Term.prototype.scrollUp = function(){
    var gone = this.buf.splice(this.top, 1)[0];
    if(this.top === 0){
        this.scroll.push(gone);
        if(this.scroll.length > 2000) this.scroll.shift();
    }
    this.buf.splice(this.bot, 0, this.blankRow());
};
Term.prototype.newline = function(){
    if(this.cy === this.bot) this.scrollUp();
    else if(this.cy < this.rows-1) this.cy++;
};
Term.prototype.put = function(ch){
    if(this.wrapNext){ this.cx = 0; this.newline(); this.wrapNext = false; }
    if(this.cx >= this.cols){ this.cx = 0; this.newline(); }
    this.buf[this.cy][this.cx] = [ch, Object.assign({}, this.attr)];
    this.cx++;
    if(this.cx >= this.cols) this.wrapNext = true;
};
Term.prototype.eraseInRow = function(y, from, to){
    for(var x=from; x<=to && x<this.cols; x++)
        this.buf[y][x] = [' ', Object.assign({}, DEF)];
};

Term.prototype.write = function(s){
    for(var i=0;i<s.length;i++){
        var c = s[i];
        if(this.st === 0){
            if(c === '\x1b'){ this.st = 1; this.pbuf=''; continue; }
            if(c === '\r'){ this.cx = 0; this.wrapNext=false; continue; }
            if(c === '\n' || c === '\x0b' || c === '\x0c'){ this.newline(); this.wrapNext=false; continue; }
            if(c === '\b'){ this.cx = Math.max(0, this.cx-1); this.wrapNext=false; continue; }
            if(c === '\t'){ this.cx = Math.min(this.cols-1, (Math.floor(this.cx/8)+1)*8); continue; }
            if(c === '\x07') continue;
            if(c < ' ') continue;
            this.put(c);
            continue;
        }
        if(this.st === 1){                    /* after ESC */
            if(c === '['){ this.st = 2; this.pbuf=''; continue; }
            if(c === ']'){ this.st = 3; this.pbuf=''; continue; }
            if(c === '('||c === ')'||c === '#'||c === '%'){ this.st = 4; continue; }
            if(c === 'M'){ if(this.cy===this.top){ this.buf.splice(this.bot,1);
                    this.buf.splice(this.top,0,this.blankRow()); } else this.cy--; this.st=0; continue; }
            if(c === '7'){ this.saved = {cx:this.cx, cy:this.cy, attr:Object.assign({},this.attr)}; this.st=0; continue; }
            if(c === '8'){ if(this.saved){ this.cx=this.saved.cx; this.cy=this.saved.cy;
                    this.attr=Object.assign({},this.saved.attr);} this.st=0; continue; }
            if(c === 'c'){ this.reset(); this.st=0; continue; }
            this.st = 0; continue;
        }
        if(this.st === 4){ this.st = 0; continue; }   /* charset byte */
        if(this.st === 3){                            /* OSC ... BEL or ESC\ */
            if(c === '\x07'){ this.st = 0; continue; }
            if(c === '\x1b'){ this.st = 5; continue; }
            continue;
        }
        if(this.st === 5){ this.st = 0; continue; }
        if(this.st === 2){                            /* CSI */
            if(c >= '@' && c <= '~'){ this.csi(this.pbuf, c); this.st = 0; this.pbuf=''; }
            else this.pbuf += c;
            continue;
        }
    }
};

Term.prototype.csi = function(raw, cmd){
    var priv = raw[0] === '?';
    var body = priv ? raw.slice(1) : raw;
    var ps = body.split(';').map(function(x){ return x===''?null:parseInt(x,10); });
    var p0 = ps[0]===null||isNaN(ps[0]) ? null : ps[0];
    var n = p0===null ? 1 : p0;
    var y;

    switch(cmd){
        case 'A': this.cy = Math.max(this.top, this.cy - n); break;
        case 'B': this.cy = Math.min(this.bot, this.cy + n); break;
        case 'C': this.cx = Math.min(this.cols-1, this.cx + n); this.wrapNext=false; break;
        case 'D': this.cx = Math.max(0, this.cx - n); this.wrapNext=false; break;
        case 'E': this.cy = Math.min(this.bot, this.cy+n); this.cx=0; break;
        case 'F': this.cy = Math.max(this.top, this.cy-n); this.cx=0; break;
        case 'G': case '\x60': this.cx = Math.min(this.cols-1, Math.max(0, n-1)); break;
        case 'd': this.cy = Math.min(this.rows-1, Math.max(0, n-1)); break;
        case 'H': case 'f':
            this.cy = Math.min(this.rows-1, Math.max(0, (p0===null?1:p0)-1));
            this.cx = Math.min(this.cols-1, Math.max(0, (ps[1]==null||isNaN(ps[1])?1:ps[1])-1));
            this.wrapNext=false;
            break;
        case 'J': {
            var mode = p0===null?0:p0;
            if(mode===0){ this.eraseInRow(this.cy, this.cx, this.cols-1);
                for(y=this.cy+1;y<this.rows;y++) this.buf[y]=this.blankRow(); }
            else if(mode===1){ this.eraseInRow(this.cy, 0, this.cx);
                for(y=0;y<this.cy;y++) this.buf[y]=this.blankRow(); }
            else { for(y=0;y<this.rows;y++) this.buf[y]=this.blankRow();
                   if(mode===3) this.scroll=[]; }
            break;
        }
        case 'K': {
            var km = p0===null?0:p0;
            if(km===0) this.eraseInRow(this.cy, this.cx, this.cols-1);
            else if(km===1) this.eraseInRow(this.cy, 0, this.cx);
            else this.eraseInRow(this.cy, 0, this.cols-1);
            break;
        }
        case 'L': for(var i=0;i<n;i++){ this.buf.splice(this.bot,1);
                    this.buf.splice(this.cy,0,this.blankRow()); } break;
        case 'M': for(var i2=0;i2<n;i2++){ this.buf.splice(this.cy,1);
                    this.buf.splice(this.bot,0,this.blankRow()); } break;
        case 'P': {
            var row = this.buf[this.cy];
            row.splice(this.cx, n);
            while(row.length < this.cols) row.push([' ', Object.assign({}, DEF)]);
            break;
        }
        case '@': {
            var row2 = this.buf[this.cy];
            for(var k=0;k<n;k++) row2.splice(this.cx, 0, [' ', Object.assign({}, DEF)]);
            row2.length = this.cols;
            break;
        }
        case 'X': this.eraseInRow(this.cy, this.cx, this.cx + n - 1); break;
        case 'r':
            this.top = Math.max(0, (p0===null?1:p0)-1);
            this.bot = Math.min(this.rows-1, (ps[1]==null||isNaN(ps[1])?this.rows:ps[1])-1);
            if(this.bot <= this.top) { this.top=0; this.bot=this.rows-1; }
            this.cx=0; this.cy=this.top;
            break;
        case 's': this.saved = {cx:this.cx, cy:this.cy, attr:Object.assign({},this.attr)}; break;
        case 'u': if(this.saved){ this.cx=this.saved.cx; this.cy=this.saved.cy;
                    this.attr=Object.assign({},this.saved.attr); } break;
        case 'h': if(priv && (p0===1049 || p0===47 || p0===1047)){
                      this.altSave = this.buf; this.reset(); } break;
        case 'l': if(priv && (p0===1049 || p0===47 || p0===1047)){
                      if(this.altSave){ this.buf = this.altSave; this.altSave=null;
                          this.cx=0; this.cy=Math.min(this.cy,this.rows-1); } } break;
        case 'm': this.sgr(ps); break;
        default: break;
    }
};

Term.prototype.sgr = function(ps){
    if(!ps.length || (ps.length===1 && ps[0]===null)) { this.attr = Object.assign({}, DEF); return; }
    for(var i=0;i<ps.length;i++){
        var v = ps[i];
        if(v===null||isNaN(v)) v = 0;
        if(v===0) this.attr = Object.assign({}, DEF);
        else if(v===1) this.attr.bold = true;
        else if(v===2) this.attr.dim = true;
        else if(v===4) this.attr.ul = true;
        else if(v===7) this.attr.inv = true;
        else if(v===22){ this.attr.bold=false; this.attr.dim=false; }
        else if(v===24) this.attr.ul = false;
        else if(v===27) this.attr.inv = false;
        else if(v>=30 && v<=37) this.attr.fg = v-30;
        else if(v===39) this.attr.fg = -1;
        else if(v>=40 && v<=47) this.attr.bg = v-40;
        else if(v===49) this.attr.bg = -1;
        else if(v>=90 && v<=97) this.attr.fg = v-90+8;
        else if(v>=100 && v<=107) this.attr.bg = v-100+8;
        else if(v===38 || v===48){
            var isFg = v===38;
            if(ps[i+1]===5){ var idx = ps[i+2]||0;
                if(isFg) this.attr.fg = idx; else this.attr.bg = idx; i+=2; }
            else if(ps[i+1]===2){
                var col = 'rgb('+(ps[i+2]||0)+','+(ps[i+3]||0)+','+(ps[i+4]||0)+')';
                if(isFg) this.attr.fg = col; else this.attr.bg = col; i+=4; }
        }
    }
};

Term.prototype.styleOf = function(a){
    var fg = a.fg, bg = a.bg;
    if(a.inv){ var t=fg; fg = (bg===-1?0:bg); bg = (t===-1?7:t); }
    var css = '';
    if(fg !== -1) css += 'color:' + (typeof fg==='string'?fg:PAL[a.bold&&fg<8?fg+8:fg]) + ';';
    if(bg !== -1) css += 'background:' + (typeof bg==='string'?bg:PAL[bg]) + ';';
    if(a.bold) css += 'font-weight:700;';
    if(a.dim)  css += 'opacity:.65;';
    if(a.ul)   css += 'text-decoration:underline;';
    return css;
};
Term.prototype.render = function(){
    var esc = function(s){ return s.replace(/[&<>]/g, function(c){
        return {'&':'&amp;','<':'&lt;','>':'&gt;'}[c]; }); };
    var out = [];
    var all = this.scroll.concat(this.buf);
    var base = this.scroll.length;
    for(var y=0;y<all.length;y++){
        var row = all[y], line = '', cur='', run='';
        var isCursorRow = (y - base) === this.cy;
        for(var x=0;x<row.length;x++){
            var cell = row[x];
            var st = this.styleOf(cell[1]);
            var isCur = isCursorRow && x === this.cx;
            if(isCur) st += 'background:#e8a33d;color:#080b10;';
            if(st !== cur){
                if(run) line += cur ? '<span style="'+cur+'">'+esc(run)+'</span>' : esc(run);
                run=''; cur=st;
            }
            run += cell[0];
        }
        if(run) line += cur ? '<span style="'+cur+'">'+esc(run)+'</span>' : esc(run);
        out.push(line.replace(/(\s+)$/, ''));
    }
    while(out.length && out[out.length-1] === '') out.pop();
    this.el.innerHTML = out.join('\n');
};

/* ---------------- terminal wiring ---------------- */
var term = null, termWs = null, termPaint = null;

function termMeasure(){
    var el = $('term');
    var probe = document.createElement('span');
    probe.style.cssText = 'position:absolute;visibility:hidden;white-space:pre';
    probe.textContent = 'X'.repeat(100);
    el.appendChild(probe);
    var cw = probe.getBoundingClientRect().width / 100;
    var lh = probe.getBoundingClientRect().height;
    el.removeChild(probe);
    if(!cw || !lh) return {cols:100, rows:30};
    var box = el.getBoundingClientRect();
    return {
        cols: Math.max(20, Math.floor((box.width  - 16) / cw)),
        rows: Math.max(5,  Math.floor((box.height - 10) / lh))
    };
}
function termSchedulePaint(){
    if(termPaint) return;
    termPaint = requestAnimationFrame(function(){
        termPaint = null;
        if(!term) return;
        var el = $('term');
        var atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 30;
        term.render();
        if(atBottom) el.scrollTop = el.scrollHeight;
    });
}
function termConnect(){
    var el = $('term');
    if(termWs){ try{ termWs.close(); }catch(e){} termWs = null; }
    term = new Term(el);
    var size = termMeasure();
    term.resize(size.cols, size.rows);
    term.render();

    $('tstat').textContent = 'Connecting...';
    $('tdot').className = 'dot bad';
    var proto = location.protocol==='https:'?'wss://':'ws://';
    var ws = new WebSocket(proto + location.host + '/admin/ws/terminal');
    ws.binaryType = 'arraybuffer';
    termWs = ws;
    var dec = new TextDecoder('utf-8', {fatal:false});

    ws.onopen = function(){
        $('tstat').textContent = 'Connected  ' + term.cols + 'x' + term.rows;
        $('tdot').className = 'dot';
        ws.send(JSON.stringify({type:'resize', cols:term.cols, rows:term.rows}));
        setTimeout(function(){ el.focus(); }, 50);
    };
    ws.onmessage = function(ev){
        var text = typeof ev.data === 'string' ? ev.data : dec.decode(new Uint8Array(ev.data), {stream:true});
        term.write(text);
        termSchedulePaint();
    };
    ws.onclose = function(){
        $('tstat').textContent = 'Session closed';
        $('tdot').className = 'dot bad';
    };
    ws.onerror = function(){ $('tstat').textContent = 'Connection failed'; };
}
function termSend(s){ if(termWs && termWs.readyState === 1) termWs.send(s); }

function wireTerm(){
    var el = $('term');
    $('tnew').onclick = termConnect;
    $('tclear').onclick = function(){
        if(term){ term.scroll = []; term.reset(); term.render(); }
        termSend('\f');
    };
    el.addEventListener('keydown', function(e){
        if(!termWs || termWs.readyState !== 1) return;
        if((e.ctrlKey||e.metaKey) && e.key.toLowerCase() === 'v') return;   /* let paste through */
        if((e.ctrlKey||e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'c') return;
        var k = e.key, s = null;
        if(k === 'Enter') s = '\r';
        else if(k === 'Backspace') s = '\x7f';
        else if(k === 'Tab') s = '\t';
        else if(k === 'Escape') s = '\x1b';
        else if(k === 'ArrowUp') s = '\x1b[A';
        else if(k === 'ArrowDown') s = '\x1b[B';
        else if(k === 'ArrowRight') s = '\x1b[C';
        else if(k === 'ArrowLeft') s = '\x1b[D';
        else if(k === 'Home') s = '\x1b[H';
        else if(k === 'End') s = '\x1b[F';
        else if(k === 'PageUp') s = '\x1b[5~';
        else if(k === 'PageDown') s = '\x1b[6~';
        else if(k === 'Delete') s = '\x1b[3~';
        else if(k === 'Insert') s = '\x1b[2~';
        else if(/^F\d+$/.test(k)){
            var map = {F1:'\x1bOP',F2:'\x1bOQ',F3:'\x1bOR',F4:'\x1bOS',F5:'\x1b[15~',
                       F6:'\x1b[17~',F7:'\x1b[18~',F8:'\x1b[19~',F9:'\x1b[20~',
                       F10:'\x1b[21~',F11:'\x1b[23~',F12:'\x1b[24~'};
            s = map[k] || null;
        }
        else if(e.ctrlKey && k.length === 1){
            var code = k.toUpperCase().charCodeAt(0);
            if(code >= 64 && code <= 95) s = String.fromCharCode(code - 64);
            else if(k === ' ') s = '\x00';
        }
        else if(k.length === 1) s = k;
        if(s !== null){ e.preventDefault(); termSend(s); }
    });
    el.addEventListener('paste', function(e){
        e.preventDefault();
        termSend((e.clipboardData || window.clipboardData).getData('text'));
    });
    el.addEventListener('click', function(){
        if(!window.getSelection().toString()) el.focus();
    });
    window.addEventListener('resize', function(){
        if(!term || !termWs || termWs.readyState !== 1) return;
        var s = termMeasure();
        if(s.cols !== term.cols || s.rows !== term.rows){
            term.resize(s.cols, s.rows);
            termSend(JSON.stringify({type:'resize', cols:s.cols, rows:s.rows}));
            $('tstat').textContent = 'Connected  ' + s.cols + 'x' + s.rows;
            termSchedulePaint();
        }
    });
}
/* a fresh shell every time the tab is opened */
TAB_INIT.term = function(){
    if(!termWs || termWs.readyState > 1) termConnect();
    setTimeout(function(){ $('term').focus(); }, 60);
};

/* ---------------- app start ---------------- */
function startApp(){
    wireTabs(); wireFiles(); wireShares(); wireCaddy(); wireEditor(); wireApi(); wireTerm();
    loadDash();
    setInterval(function(){ if(state.tab === 'dash') loadDash(); }, 60000);
    var want = (location.hash || '').replace('#','');
    if(want && document.getElementById('pane-' + want)) showTab(want);
}
boot();
`;

/* ---- assemble the page ------------------------------------------------- */
function adminPage() {
    return '<!doctype html>\n<html lang="en">\n<head>\n' +
        '<meta charset="utf-8">\n' +
        '<meta name="viewport" content="width=device-width,initial-scale=1">\n' +
        '<meta name="robots" content="noindex,nofollow">\n' +
        '<title>' + escapeHTML(settings.siteName) + ' admin</title>\n' +
        '<style>' + ADMIN_CSS + '</style>\n</head>\n<body>\n' +
        ADMIN_BODY +
        '\n<script>\n' +
        ADMIN_JS_CORE + ADMIN_JS_GATE + ADMIN_JS_DASH +
        ADMIN_JS_FILES + ADMIN_JS_MISC + ADMIN_JS_API + ADMIN_JS_TERM +
        '\n</' + 'script>\n</body>\n</html>';
}
