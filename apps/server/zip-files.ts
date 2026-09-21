/** Bounded, uncompressed ZIP export. Paths come from the validated bundle manifest. */
export function zipFiles(files: Array<{ path: string; bytes: Buffer }>) {
  let offset = 0;
  const local: Buffer[] = [],
    central: Buffer[] = [];
  for (const file of files) {
    if (
      !file.path ||
      file.path.startsWith("/") ||
      file.path.split("/").some((p) => p === ".." || p === ".") ||
      file.path.includes("\\")
    )
      throw Error("Invalid ZIP path");
    const name = Buffer.from(file.path);
    let crc = 0xffffffff;
    for (const b of file.bytes) {
      crc ^= b;
      for (let i = 0; i < 8; i++)
        crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
    crc = (crc ^ 0xffffffff) >>> 0;
    const h = Buffer.alloc(30);
    h.writeUInt32LE(0x04034b50);
    h.writeUInt16LE(20, 4);
    h.writeUInt16LE(0x800, 6);
    h.writeUInt16LE(33, 12);
    h.writeUInt32LE(crc, 14);
    h.writeUInt32LE(file.bytes.length, 18);
    h.writeUInt32LE(file.bytes.length, 22);
    h.writeUInt16LE(name.length, 26);
    const d = Buffer.alloc(46);
    d.writeUInt32LE(0x02014b50);
    d.writeUInt16LE(20, 4);
    d.writeUInt16LE(20, 6);
    d.writeUInt16LE(0x800, 8);
    d.writeUInt16LE(33, 14);
    d.writeUInt32LE(crc, 16);
    d.writeUInt32LE(file.bytes.length, 20);
    d.writeUInt32LE(file.bytes.length, 24);
    d.writeUInt16LE(name.length, 28);
    d.writeUInt32LE(offset, 42);
    local.push(h, name, file.bytes);
    central.push(d, name);
    offset += h.length + name.length + file.bytes.length;
  }
  const directory = Buffer.concat(central),
    end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directory, end]);
}
