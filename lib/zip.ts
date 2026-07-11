import { crc32 } from "node:zlib";

export type ZipEntry = { name: string; data: Buffer | string };

function dosDateTime(date: Date): { time: number; date: number } {
  return {
    time:
      (date.getUTCHours() << 11) |
      (date.getUTCMinutes() << 5) |
      Math.floor(date.getUTCSeconds() / 2),
    date:
      ((Math.max(1980, date.getUTCFullYear()) - 1980) << 9) |
      ((date.getUTCMonth() + 1) << 5) |
      date.getUTCDate(),
  };
}

/**
 * Classic (non-ZIP64) format limits. Entry payloads, header offsets, and the
 * entry count are 32-/16-bit fields; exceeding them corrupts the archive, so
 * buildZip refuses loudly instead. Callers must budget payload size before
 * building (the export route enforces its own byte cap well below this).
 */
const ZIP_MAX_UINT32 = 0xffff_ffff;
const ZIP_MAX_ENTRIES = 0xffff;

/**
 * Builds an uncompressed (STORE) ZIP archive. CSV/text payloads stay small at
 * clinic scale and a stored archive avoids adding an external dependency for
 * the data-export requirement.
 */
export function buildZip(entries: ZipEntry[], now = new Date()): Buffer {
  if (entries.length > ZIP_MAX_ENTRIES) {
    throw new RangeError(`ZIP entry count ${entries.length} exceeds the format limit of ${ZIP_MAX_ENTRIES}.`);
  }
  const { time, date } = dosDateTime(now);
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data, "utf8");
    if (data.length > ZIP_MAX_UINT32) {
      throw new RangeError(`ZIP entry "${entry.name}" (${data.length} bytes) exceeds the 4 GiB format limit.`);
    }
    const checksum = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(0, 8); // method: store
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28); // extra length
    localParts.push(local, name, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4); // made by
    central.writeUInt16LE(20, 6); // version needed
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(date, 14);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, name);

    offset += 30 + name.length + data.length;
    if (offset > ZIP_MAX_UINT32) {
      throw new RangeError("ZIP archive exceeds the 4 GiB non-ZIP64 format limit.");
    }
  }

  const centralSize = centralParts.reduce((total, part) => total + part.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);

  return Buffer.concat([...localParts, ...centralParts, end]);
}

// Leading characters spreadsheet applications interpret as a formula (DDE /
// =HYPERLINK exfiltration). Exported cells can carry patient-influenced text,
// so these cells are neutralized with a leading apostrophe and always quoted.
const FORMULA_PREFIXES = new Set(["=", "+", "-", "@", "\t", "\r"]);

export function csvRow(values: Array<string | number | null | undefined>): string {
  return values
    .map((value) => {
      if (value === null || value === undefined) return "";
      let text = String(value);
      let mustQuote = /[",\n\r]/.test(text);
      if (typeof value === "string" && text.length > 0 && FORMULA_PREFIXES.has(text[0])) {
        text = `'${text}`;
        mustQuote = true;
      }
      return mustQuote ? `"${text.replaceAll('"', '""')}"` : text;
    })
    .join(",");
}
