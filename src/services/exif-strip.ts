/**
 * exif-strip.ts — Lightweight EXIF/metadata stripping for image buffers.
 *
 * Strips APP1–APP15 marker segments (0xE0–0xEF) from JPEG data before
 * forwarding to LLM vision APIs. These segments carry EXIF, XMP, IPTC,
 * ICC profiles, and GPS coordinates — none of which should be sent to
 * third-party AI services.
 *
 * Non-JPEG buffers are returned unchanged.
 */

/**
 * Strip EXIF and all APPn metadata segments from a JPEG buffer.
 * Keeps SOF, DHT, DQT, DRI, and SOS (image data) intact.
 */
export function stripExif(buf: Buffer): Buffer {
  // Verify JPEG SOI marker (0xFF 0xD8)
  if (buf.length < 4 || buf[0] !== 0xFF || buf[1] !== 0xD8) return buf

  const out: number[] = [0xFF, 0xD8]
  let i = 2

  while (i < buf.length - 1) {
    if (buf[i] !== 0xFF) break

    const marker = buf[i + 1]

    // SOS (0xDA) — start of scan / image data; copy remainder verbatim
    if (marker === 0xDA) {
      const rest = buf.slice(i)
      for (let j = 0; j < rest.length; j++) out.push(rest[j])
      break
    }

    // Need at least 2 more bytes for segment length
    if (i + 3 >= buf.length) break
    const segLen = buf.readUInt16BE(i + 2)
    const totalSegLen = 2 + segLen // marker(2) + length field(2) + data(segLen-2)

    // APP0–APP15 (0xE0–0xEF): carry EXIF, XMP, IPTC, GPS — skip entirely
    if (marker >= 0xE0 && marker <= 0xEF) {
      i += totalSegLen
      continue
    }

    // All other markers (SOF, DHT, DQT, DRI, COM, etc.) — keep
    const seg = buf.slice(i, i + totalSegLen)
    for (let j = 0; j < seg.length; j++) out.push(seg[j])
    i += totalSegLen
  }

  return Buffer.from(out)
}

/**
 * Strip EXIF from a base64-encoded image string.
 * Returns a new base64 string (raw, no data URI prefix).
 *
 * If the input includes a data URI prefix (data:image/...;base64,...) it is
 * preserved in the return value with the stripped image data.
 */
export function stripExifBase64(input: string): string {
  const dataUriMatch = input.match(/^(data:[^;]+;base64,)(.+)$/)
  const prefix = dataUriMatch ? dataUriMatch[1] : ''
  const raw = dataUriMatch ? dataUriMatch[2] : input

  try {
    const buf = Buffer.from(raw, 'base64')
    const stripped = stripExif(buf)
    return prefix + stripped.toString('base64')
  } catch {
    // If base64 decode fails, return original unchanged
    return input
  }
}

/**
 * Detect whether a buffer looks like a JPEG (starts with 0xFF 0xD8).
 */
export function isJpeg(buf: Buffer): boolean {
  return buf.length >= 2 && buf[0] === 0xFF && buf[1] === 0xD8
}
