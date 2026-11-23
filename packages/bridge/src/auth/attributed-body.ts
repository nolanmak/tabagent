// Decode the plain text out of a Messages `attributedBody` blob (OA3).
//
// The blob is an NSArchiver "typedstream" of an NSAttributedString. On current macOS (checked on 26.3,
// 2026-11-23) ~74% of recent rows have `message.text = NULL` and the body only here. Layout around the
// string we want:
//   ... "NSString" 0x01 0x94 0x84 0x01 '+' <length> <UTF-8 bytes> ...
// <length> is one byte when < 0x80, else 0x81 + uint16 LE, 0x82 + uint32 LE (typedstream integer tags).
// Everything after the string (attribute runs, dictionaries) is ignored.

const enc = new TextEncoder();
const NSSTRING = enc.encode("NSString");
const PLUS = 0x2b;

function indexOf(hay: Uint8Array, needle: Uint8Array, from = 0): number {
  outer: for (let i = from; i <= hay.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) if (hay[i + j] !== needle[j]) continue outer;
    return i;
  }
  return -1;
}

/** Returns the message text, or null when the blob is not a recognisable typedstream string. */
export function decodeAttributedBody(blob: Uint8Array | null | undefined): string | null {
  if (!blob || blob.length < 16) return null;
  const at = indexOf(blob, NSSTRING);
  if (at < 0) return null;
  // The '+' (C-string-with-length type) follows within a few bytes of the class name.
  let i = at + NSSTRING.length;
  const stop = Math.min(blob.length, i + 12);
  while (i < stop && blob[i] !== PLUS) i++;
  if (i >= stop) return null;
  i++;
  if (i >= blob.length) return null;
  let len: number;
  const tag = blob[i];
  if (tag === 0x81) {
    if (i + 3 > blob.length) return null;
    len = blob[i + 1] | (blob[i + 2] << 8);
    i += 3;
  } else if (tag === 0x82) {
    if (i + 5 > blob.length) return null;
    len = (blob[i + 1] | (blob[i + 2] << 8) | (blob[i + 3] << 16) | (blob[i + 4] << 24)) >>> 0;
    i += 5;
  } else if (tag < 0x80) {
    len = tag;
    i += 1;
  } else return null;
  if (len === 0 || i + len > blob.length) return null;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(blob.subarray(i, i + len));
  } catch {
    return null;
  }
}

/** Build a minimal typedstream blob the way Messages does (test fixtures, and to replace real content). */
export function encodeAttributedBody(text: string, template?: Uint8Array): Uint8Array {
  const body = enc.encode(text);
  const lenBytes = body.length < 0x80 ? [body.length] : body.length <= 0xffff ? [0x81, body.length & 0xff, body.length >> 8] : [0x82, body.length & 0xff, (body.length >> 8) & 0xff, (body.length >> 16) & 0xff, (body.length >>> 24) & 0xff];
  if (template) {
    // Splice: keep the template's bytes before and after its own string, replace the string.
    const at = indexOf(template, NSSTRING);
    let i = at + NSSTRING.length;
    while (template[i] !== PLUS) i++;
    i++;
    const tag = template[i];
    const [hdr, len] = tag === 0x81 ? [3, template[i + 1] | (template[i + 2] << 8)] : tag === 0x82 ? [5, (template[i + 1] | (template[i + 2] << 8) | (template[i + 3] << 16) | (template[i + 4] << 24)) >>> 0] : [1, tag];
    const before = template.subarray(0, i);
    const after = template.subarray(i + hdr + len);
    return concat([before, Uint8Array.from(lenBytes), body, fixTrailingLengths(after, len, body.length)]);
  }
  const head = Uint8Array.from([0x04, 0x0b, ...enc.encode("streamtyped"), 0x81, 0xe8, 0x03, 0x84, 0x01, 0x40, 0x84, 0x84, 0x84, 0x12, ...enc.encode("NSAttributedString"), 0x00, 0x84, 0x84, 0x08, ...enc.encode("NSObject"), 0x00, 0x85, 0x92, 0x84, 0x84, 0x84, 0x08, ...enc.encode("NSString"), 0x01, 0x94, 0x84, 0x01, PLUS]);
  const tail = Uint8Array.from([0x86, 0x84, 0x02, 0x69, 0x49, 0x01, ...(body.length < 0x80 ? [body.length] : [0x81, body.length & 0xff, body.length >> 8]), 0x92, 0x84, 0x84, 0x84, 0x0c, ...enc.encode("NSDictionary"), 0x00, 0x94, 0x84, 0x01, 0x69, 0x01, 0x92, 0x84, 0x96, 0x96, 0x1d, ...enc.encode("__kIMMessagePartAttributeName"), 0x86, 0x92, 0x84, 0x84, 0x84, 0x08, ...enc.encode("NSNumber"), 0x00, 0x84, 0x84, 0x07, ...enc.encode("NSValue"), 0x00, 0x94, 0x84, 0x01, 0x2a, 0x84, 0x99, 0x99, 0x00, 0x86, 0x86, 0x86]);
  return concat([head, Uint8Array.from(lenBytes), body, tail]);
}

/** The attribute run after the string repeats its length ("iI" <len>); keep it consistent when splicing. */
function fixTrailingLengths(after: Uint8Array, oldLen: number, newLen: number): Uint8Array {
  const marker = [0x84, 0x02, 0x69, 0x49, 0x01];
  const at = indexOf(after, Uint8Array.from(marker));
  if (at < 0 || at > 8) return after;
  const p = at + marker.length;
  const oldBytes = oldLen < 0x80 ? 1 : 3;
  const enc2 = newLen < 0x80 ? [newLen] : [0x81, newLen & 0xff, newLen >> 8];
  return concat([after.subarray(0, p), Uint8Array.from(enc2), after.subarray(p + oldBytes)]);
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}
