'use strict';
// =====================================================================
// ZKTeco scanner client (TCP, port 4370) — the parts the relay needs:
// connect (with the scanner's Comm Key), sizes, serial, firmware, time,
// users, attendance log, enable/disable. A port of pyzk 0.9 (MIT), the
// library ZKTime-style tools have used for years — same packets, same
// checksum, same decoding. Node built-ins only.
//
// Every TCP frame is: 0x5050 0x7D82 <u32 length> then the ZK packet
// (<u16 command> <u16 checksum> <u16 session> <u16 reply> <data>).
// =====================================================================
const net = require('net');

const CMD = {
  CONNECT: 1000, EXIT: 1001, ENABLEDEVICE: 1002, DISABLEDEVICE: 1003, GET_VERSION: 1100, AUTH: 1102,
  PREPARE_DATA: 1500, DATA: 1501, FREE_DATA: 1502, PREPARE_BUFFER: 1503, READ_BUFFER: 1504,
  ACK_OK: 2000, ACK_ERROR: 2001, ACK_DATA: 2002, ACK_UNAUTH: 2005,
  USERTEMP_RRQ: 9, OPTIONS_RRQ: 11, ATTLOG_RRQ: 13, GET_FREE_SIZES: 50, GET_TIME: 201,
};
const FCT_USER = 5;
const USHRT_MAX = 65535;
const MAX_CHUNK = 0xFFC0;

/** zkemsdk.c checksum, as pyzk does it. */
const checksum = (buf) => {
  let sum = 0;
  let i = 0;
  for (; i + 1 < buf.length; i += 2) {
    sum += buf.readUInt16LE(i);
    if (sum > USHRT_MAX) sum -= USHRT_MAX;
  }
  if (i < buf.length) sum += buf[i];
  while (sum > USHRT_MAX) sum -= USHRT_MAX;
  sum = ~sum;
  while (sum < 0) sum += USHRT_MAX;
  return sum & 0xFFFF;
};

/** commpro.c MakeKey: the Comm Key scrambled with the session id. */
const makeCommKey = (key, sessionId, ticks = 50) => {
  let k = 0;
  for (let i = 0; i < 32; i += 1) k = (key & (1 << i)) ? ((k << 1) | 1) >>> 0 : (k << 1) >>> 0;
  k = (k + sessionId) >>> 0;
  const b = Buffer.alloc(4);
  b.writeUInt32LE(k, 0);
  const x = [b[0] ^ 0x5A, b[1] ^ 0x4B, b[2] ^ 0x53, b[3] ^ 0x4F]; // 'Z' 'K' 'S' 'O'
  const swapped = [x[2], x[3], x[0], x[1]];
  const B = ticks & 0xFF;
  return Buffer.from([swapped[0] ^ B, swapped[1] ^ B, B, swapped[3] ^ B]);
};

/** zkemsdk.c DecodeTime → a local-time Date (the scanner keeps wall-clock time). */
const decodeTime = (u32) => {
  let t = u32;
  const second = t % 60; t = Math.floor(t / 60);
  const minute = t % 60; t = Math.floor(t / 60);
  const hour = t % 24; t = Math.floor(t / 24);
  const day = (t % 31) + 1; t = Math.floor(t / 31);
  const month = (t % 12) + 1; t = Math.floor(t / 12);
  return new Date(2000 + t, month - 1, day, hour, minute, second);
};

const cstr = (buf) => {
  const end = buf.indexOf(0);
  return (end === -1 ? buf : buf.subarray(0, end)).toString('latin1').trim();
};

class K40 {
  constructor({ ip, port = 4370, password = 0, timeout = 15000 }) {
    this.ip = ip; this.port = port; this.password = Number(password) || 0; this.timeout = timeout;
    this.sock = null; this.buf = Buffer.alloc(0); this.sessionId = 0; this.replyId = USHRT_MAX - 1;
    this.connected = false;
  }

  // --- transport -------------------------------------------------------
  open() {
    return new Promise((resolve, reject) => {
      const s = net.createConnection({ host: this.ip, port: this.port });
      s.setTimeout(this.timeout);
      s.once('connect', () => { this.sock = s; resolve(); });
      s.once('error', reject);
      s.once('timeout', () => { s.destroy(); reject(new Error('connect timed out')); });
      s.on('data', (d) => { this.buf = Buffer.concat([this.buf, d]); if (this.waiter) this.waiter(); });
      s.on('close', () => { this.sock = null; if (this.waiter) this.waiter(); });
    });
  }

  /** One complete frame: { command, session, reply, data }. */
  readFrame() {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.waiter = null; reject(new Error('scanner did not answer')); }, this.timeout);
      const tryParse = () => {
        if (this.buf.length >= 8) {
          if (this.buf.readUInt16LE(0) !== 0x5050 || this.buf.readUInt16LE(2) !== 0x7D82) {
            clearTimeout(timer); this.waiter = null; return reject(new Error('bad frame from scanner'));
          }
          const len = this.buf.readUInt32LE(4);
          if (this.buf.length >= 8 + len) {
            const pkt = this.buf.subarray(8, 8 + len);
            this.buf = this.buf.subarray(8 + len);
            clearTimeout(timer); this.waiter = null;
            return resolve({ command: pkt.readUInt16LE(0), session: pkt.readUInt16LE(4), reply: pkt.readUInt16LE(6), data: pkt.subarray(8) });
          }
        }
        if (!this.sock) { clearTimeout(timer); this.waiter = null; return reject(new Error('scanner closed the connection')); }
        return undefined;
      };
      this.waiter = tryParse;
      tryParse();
    });
  }

  send(command, data = Buffer.alloc(0)) {
    const head = Buffer.alloc(8);
    head.writeUInt16LE(command, 0); head.writeUInt16LE(0, 2); head.writeUInt16LE(this.sessionId, 4); head.writeUInt16LE(this.replyId, 6);
    const pkt = Buffer.concat([head, data]);
    pkt.writeUInt16LE(checksum(pkt), 2);
    this.replyId = (this.replyId + 1) % USHRT_MAX;
    pkt.writeUInt16LE(this.replyId, 6);
    const top = Buffer.alloc(8);
    top.writeUInt16LE(0x5050, 0); top.writeUInt16LE(0x7D82, 2); top.writeUInt32LE(pkt.length, 4);
    this.sock.write(Buffer.concat([top, pkt]));
  }

  async cmd(command, data) {
    this.send(command, data);
    const f = await this.readFrame();
    this.replyId = f.reply;
    return f;
  }

  async ok(command, data, what) {
    const f = await this.cmd(command, data);
    if (![CMD.ACK_OK, CMD.PREPARE_DATA, CMD.DATA].includes(f.command)) throw new Error(`${what}: scanner answered ${f.command}`);
    return f;
  }

  // --- session ---------------------------------------------------------
  async connect() {
    await this.open();
    this.sessionId = 0; this.replyId = USHRT_MAX - 1;
    let f = await this.cmd(CMD.CONNECT);
    this.sessionId = f.session;
    if (f.command === CMD.ACK_UNAUTH) f = await this.cmd(CMD.AUTH, makeCommKey(this.password, this.sessionId));
    if (f.command === CMD.ACK_UNAUTH) throw new Error('the scanner refused the Comm Key (SCANNER_PASSWORD)');
    if (f.command !== CMD.ACK_OK) throw new Error(`connect: scanner answered ${f.command}`);
    this.connected = true;
    return this;
  }

  async disconnect() {
    try { if (this.connected && this.sock) await this.cmd(CMD.EXIT); } catch { /* closing anyway */ }
    this.connected = false;
    if (this.sock) { this.sock.destroy(); this.sock = null; }
  }

  async disableDevice() { await this.ok(CMD.DISABLEDEVICE, undefined, 'disable'); }
  async enableDevice() { await this.ok(CMD.ENABLEDEVICE, undefined, 'enable'); }
  async freeData() { await this.ok(CMD.FREE_DATA, undefined, 'free data'); }

  // --- information -----------------------------------------------------
  async sizes() {
    const { data } = await this.ok(CMD.GET_FREE_SIZES, undefined, 'sizes');
    if (data.length < 80) throw new Error('sizes: short answer');
    const i32 = (n) => data.readInt32LE(n * 4);
    return { users: i32(4), fingers: i32(6), records: i32(8), cards: i32(12), fingersCap: i32(14), usersCap: i32(15), recordsCap: i32(16) };
  }

  async option(name) {
    const { data } = await this.ok(CMD.OPTIONS_RRQ, Buffer.from(`${name}\0`, 'latin1'), name);
    const s = cstr(data);
    return s.includes('=') ? s.slice(s.indexOf('=') + 1).replace(/=/g, '') : s;
  }

  serialNumber() { return this.option('~SerialNumber'); }

  async firmware() {
    const { data } = await this.ok(CMD.GET_VERSION, undefined, 'firmware');
    return cstr(data);
  }

  async time() {
    const { data } = await this.ok(CMD.GET_TIME, undefined, 'time');
    return decodeTime(data.readUInt32LE(0));
  }

  // --- buffered reads (ZK6: 1503 / 1504) --------------------------------
  async readChunk(start, size) {
    const req = Buffer.alloc(8);
    req.writeInt32LE(start, 0); req.writeInt32LE(size, 4);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const f = await this.cmd(CMD.READ_BUFFER, req);
      if (f.command === CMD.DATA) return f.data;
      if (f.command === CMD.PREPARE_DATA) {
        const want = f.data.readUInt32LE(0);
        const parts = [];
        let got = 0;
        while (got < want) {
          const d = await this.readFrame();
          if (d.command !== CMD.DATA) throw new Error(`chunk: expected data, got ${d.command}`);
          parts.push(d.data); got += d.data.length;
        }
        const ack = await this.readFrame();
        if (ack.command === CMD.ACK_OK) { this.replyId = ack.reply; return Buffer.concat(parts); }
      }
    }
    throw new Error(`could not read chunk ${start}:${size}`);
  }

  async readWithBuffer(command, fct = 0, ext = 0) {
    const req = Buffer.alloc(11);
    req.writeInt8(1, 0); req.writeInt16LE(command, 1); req.writeInt32LE(fct, 3); req.writeInt32LE(ext, 7);
    const f = await this.cmd(CMD.PREPARE_BUFFER, req);
    if (![CMD.ACK_OK, CMD.PREPARE_DATA, CMD.DATA].includes(f.command)) throw new Error('buffered read not supported');
    if (f.command === CMD.DATA) return f.data;                 // small enough to come at once
    const size = f.data.readUInt32LE(1);
    const parts = [];
    for (let start = 0; start < size; start += MAX_CHUNK) {
      parts.push(await this.readChunk(start, Math.min(MAX_CHUNK, size - start)));
    }
    await this.freeData();
    return Buffer.concat(parts);
  }

  /** Enrolled users: [{ uid, userId, name, privilege, card }]. */
  async users() {
    const { users } = await this.sizes();
    if (!users) return [];
    const raw = await this.readWithBuffer(CMD.USERTEMP_RRQ, FCT_USER);
    if (raw.length <= 4) return [];
    const total = raw.readUInt32LE(0);
    const rec = total / users;
    const data = raw.subarray(4);
    const out = [];
    if (rec === 28) {
      for (let o = 0; o + 28 <= data.length; o += 28) {
        const r = data.subarray(o, o + 28);
        out.push({ uid: r.readUInt16LE(0), privilege: r[2], name: cstr(r.subarray(8, 16)), card: r.readUInt32LE(16), userId: String(r.readUInt32LE(24)) });
      }
    } else {
      for (let o = 0; o + 72 <= data.length; o += 72) {
        const r = data.subarray(o, o + 72);
        out.push({ uid: r.readUInt16LE(0), privilege: r[2], name: cstr(r.subarray(11, 35)), card: r.readUInt32LE(35), userId: cstr(r.subarray(48, 72)) });
      }
    }
    return out;
  }

  /**
   * Every punch on the scanner, in log order:
   * [{ userId, at: Date (scanner local time), verify, state, uid }].
   */
  async attendance() {
    const { records } = await this.sizes();
    if (!records) return [];
    const users = await this.users();
    const byUid = new Map(users.map((u) => [u.uid, u]));
    const raw = await this.readWithBuffer(CMD.ATTLOG_RRQ);
    if (raw.length < 4) return [];
    const total = raw.readUInt32LE(0);
    const rec = total / records;
    const data = raw.subarray(4);
    const out = [];
    if (rec === 8) {
      for (let o = 0; o + 8 <= data.length; o += 8) {
        const r = data.subarray(o, o + 8);
        const uid = r.readUInt16LE(0);
        out.push({ uid, userId: byUid.get(uid)?.userId ?? String(uid), verify: r[2], at: decodeTime(r.readUInt32LE(3)), state: r[7] });
      }
    } else if (rec === 16) {
      for (let o = 0; o + 16 <= data.length; o += 16) {
        const r = data.subarray(o, o + 16);
        out.push({ uid: null, userId: String(r.readUInt32LE(0)), at: decodeTime(r.readUInt32LE(4)), verify: r[8], state: r[9] });
      }
    } else {
      for (let o = 0; o + 40 <= data.length; o += 40) {
        const r = data.subarray(o, o + 40);
        out.push({ uid: r.readUInt16LE(0), userId: cstr(r.subarray(2, 26)), verify: r[26], at: decodeTime(r.readUInt32LE(27)), state: r[31] });
      }
    }
    return out;
  }
}

module.exports = { K40, decodeTime, makeCommKey, checksum, CMD };
