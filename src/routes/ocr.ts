/**
 * Writer OCR — image to LaTeX extraction
 * Swap provider: change extractLatex() to use GLM-OCR, Mathpix, etc.
 * @module writer/ocr
 */
import { Hono } from 'hono';
import { getUser } from '../middleware/auth';
import { stripExifBase64 } from '../services/exif-strip';

export const ocrRoutes = new Hono();

// ── Swappable Provider ──────────────────────────────────────────────────────

async function extractLatex(imageBase64: string): Promise<{ latex: string; confidence: number }> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error('GEMINI_API_KEY not configured');
  }

  // Strip EXIF/metadata before forwarding to Gemini vision API
  const exifStripped = stripExifBase64(imageBase64);

  // Strip data URI prefix if present (e.g. "data:image/png;base64,...")
  // Gemini inline_data.data requires raw base64 only.
  let rawBase64 = exifStripped;
  let mimeType = 'image/png';
  const dataUriMatch = exifStripped.match(/^data:([^;]+);base64,(.+)$/);
  if (dataUriMatch) {
    mimeType = dataUriMatch[1];
    rawBase64 = dataUriMatch[2];
  }

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [
          {
            parts: [
              {
                text: 'Extract the mathematical equation from this image. Return ONLY the LaTeX code, nothing else — no explanation, no markdown fences.',
              },
              {
                inline_data: {
                  mime_type: mimeType,
                  data: rawBase64,
                },
              },
            ],
          },
        ],
      }),
      signal: AbortSignal.timeout(30_000),
    },
  );

  if (!res.ok) {
    const detail = await res.text().catch(() => 'unknown');
    const err = new Error(`Gemini Vision failed (${res.status}): ${detail}`) as Error & { statusCode?: number };
    err.statusCode = res.status;
    throw err;
  }

  const data = (await res.json()) as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
  };

  const raw = data.candidates?.[0]?.content?.parts?.[0]?.text ?? '';

  // Strip markdown code fences if the model wraps them anyway
  const latex = raw
    .replace(/^```(?:latex|tex)?\s*\n?/i, '')
    .replace(/\n?```\s*$/i, '')
    .trim();

  return { latex, confidence: latex.length > 0 ? 0.85 : 0 };
}

// ── Route ───────────────────────────────────────────────────────────────────

ocrRoutes.post('/ocr/math', async (c) => {
  const user = await getUser(c);
  if (!user) return c.json({ error: 'Unauthorized' }, 401);

  try {
    const body = await c.req.json<{ image?: string }>();
    const { image } = body;

    if (!image || typeof image !== 'string' || image.length === 0) {
      return c.json({ error: 'Missing or empty "image" field (base64 string expected)' }, 400);
    }

    // Enforce 10 MB raw image limit (base64 of 10MB ≈ 13.6M chars)
    const MAX_BASE64_LEN = 14_000_000;
    if (image.length > MAX_BASE64_LEN) {
      return c.json({ error: 'Image too large (max 10 MB)' }, 413);
    }

    const result = await extractLatex(image);
    return c.json(result);
  } catch (err: any) {
    if (err.message === 'GEMINI_API_KEY not configured') {
      return c.json({ error: 'OCR service not configured' }, 503);
    }
    if (err.message?.startsWith('Gemini Vision failed')) {
      console.error('[writer/ocr] Gemini API error:', err.message);
      // Propagate rate-limit (429) as 429 so clients can back-off correctly.
      // Any other upstream error is a generic 502.
      const upstreamStatus = err.statusCode;
      if (upstreamStatus === 429) {
        return c.json({ error: 'OCR rate limit exceeded — retry after a moment' }, 429);
      }
      return c.json({ error: 'OCR upstream error' }, 502);
    }
    console.error('[writer/ocr] extraction error:', err);
    return c.json({ error: 'OCR extraction failed' }, 500);
  }
});
