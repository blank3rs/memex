/**
 * Text out of iMessage's `attributedBody` (an NSAttributedString in Apple's legacy typedstream archive).
 * Port of ReagentX/imessage-exporter's approach: the NSString payload follows the class name as
 * 0x01 0x2B ('+', C-string type), then a typedstream integer length (0x81 = u16 LE, 0x82 = u32 LE,
 * else the byte itself), then UTF-8 bytes. Falls back to its legacy start/end-pattern parse.
 */
const NSSTRING = Buffer.from("NSString");
const START = Buffer.from([0x01, 0x2b]);
const END = Buffer.from([0x86, 0x84]);

export function decodeAttributedBody(raw: Uint8Array | null | undefined): string | null {
  if (!raw || !raw.length) return null;
  const b = Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength);
  return precise(b) ?? legacy(b);
}

function precise(b: Buffer): string | null {
  const cls = b.indexOf(NSSTRING);
  if (cls < 0) return null;
  let i = b.indexOf(START, cls + NSSTRING.length);
  if (i < 0) return null;
  i += START.length;
  if (i >= b.length) return null;
  let len = b[i++];
  if (len === 0x81) {
    if (i + 2 > b.length) return null;
    len = b.readUInt16LE(i);
    i += 2;
  } else if (len === 0x82) {
    if (i + 4 > b.length) return null;
    len = b.readUInt32LE(i);
    i += 4;
  }
  if (i + len > b.length) return null;
  return b.subarray(i, i + len).toString("utf8");
}

function legacy(b: Buffer): string | null {
  const s = b.indexOf(START);
  if (s < 0) return null;
  const body = b.subarray(s + START.length);
  const e = body.indexOf(END, 1);
  if (e < 0) return null;
  const chunk = body.subarray(0, e);
  const text = chunk.toString("utf8");
  // Drop the length prefix: 1 char when valid UTF-8, 3 when the prefix decoded lossily.
  const valid = Buffer.from(text, "utf8").equals(chunk);
  return [...text].slice(valid ? 1 : 3).join("");
}
