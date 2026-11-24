import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

/**
 * A small zip reader and writer, enough for release packages: stored and
 * deflated entries, no encryption, no zip64. Having it here means installing
 * an update needs no unzip program on the computer.
 */

const LOCAL = 0x04034b50;
const CENTRAL = 0x02014b50;
const END = 0x06054b50;

export type ZipEntry = { name: string; data: Buffer };

export function writeZip(entries: Iterable<ZipEntry>): Buffer {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  let count = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name, "utf8");
    const packed = zlib.deflateRawSync(e.data, { level: 9 });
    const store = packed.length >= e.data.length;
    const body = store ? e.data : packed;
    const crc = zlib.crc32(e.data);
    const head = Buffer.alloc(30);
    head.writeUInt32LE(LOCAL, 0);
    head.writeUInt16LE(20, 4);
    head.writeUInt16LE(0x0800, 6); // names are UTF-8
    head.writeUInt16LE(store ? 0 : 8, 8);
    head.writeUInt32LE(0x00210000, 10); // fixed date, so the same input gives the same file
    head.writeUInt32LE(crc, 14);
    head.writeUInt32LE(body.length, 18);
    head.writeUInt32LE(e.data.length, 22);
    head.writeUInt16LE(name.length, 26);
    const dir = Buffer.alloc(46);
    dir.writeUInt32LE(CENTRAL, 0);
    dir.writeUInt16LE(20, 4);
    dir.writeUInt16LE(20, 6);
    head.copy(dir, 8, 6, 30); // flags … name length
    dir.writeUInt32LE(offset, 42);
    parts.push(head, name, body);
    central.push(dir, name);
    offset += 30 + name.length + body.length;
    count++;
  }
  if (count > 0xffff || offset > 0xffffffff) throw new Error("Too large for a plain zip file.");
  const dirSize = central.reduce((n, b) => n + b.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(END, 0);
  end.writeUInt16LE(count, 8);
  end.writeUInt16LE(count, 10);
  end.writeUInt32LE(dirSize, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, ...central, end]);
}

export function readZip(buf: Buffer): ZipEntry[] {
  let at = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i--) {
    if (buf.readUInt32LE(i) === END) {
      at = i;
      break;
    }
  }
  if (at < 0) throw new Error("Not a zip file.");
  const count = buf.readUInt16LE(at + 10);
  let p = buf.readUInt32LE(at + 16);
  const out: ZipEntry[] = [];
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== CENTRAL) throw new Error("The zip file is damaged.");
    const method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16);
    const packedSize = buf.readUInt32LE(p + 20);
    const size = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString("utf8");
    p += 46 + nameLen + extraLen + commentLen;
    if (name.endsWith("/")) continue;
    if (buf.readUInt32LE(local) !== LOCAL) throw new Error("The zip file is damaged.");
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const body = buf.subarray(start, start + packedSize);
    let data: Buffer;
    if (method === 0) data = Buffer.from(body);
    else if (method === 8) data = zlib.inflateRawSync(body);
    else throw new Error(`The zip file uses a compression this program cannot read (entry ${name}).`);
    if (data.length !== size || zlib.crc32(data) !== crc) throw new Error(`The zip file is damaged (entry ${name}).`);
    out.push({ name, data });
  }
  return out;
}

/** Unpack into `dest`. An entry that would land outside `dest` is refused. */
export function extractZip(buf: Buffer, dest: string): number {
  const root = path.resolve(dest);
  const entries = readZip(buf);
  for (const e of entries) {
    const target = path.resolve(root, e.name);
    const rel = path.relative(root, target);
    if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) throw new Error(`The zip file has an entry outside its folder: ${e.name}`);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, e.data);
  }
  return entries.length;
}

/** Every file under `dir`, as zip entries named relative to it with forward slashes. */
export function* filesUnder(dir: string, skip: (rel: string) => boolean = () => false, prefix = ""): Generator<ZipEntry> {
  for (const d of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const rel = prefix + d.name;
    if (skip(rel)) continue;
    const abs = path.join(dir, d.name);
    if (d.isDirectory()) yield* filesUnder(abs, skip, rel + "/");
    else if (d.isFile()) yield { name: rel, data: fs.readFileSync(abs) };
  }
}
