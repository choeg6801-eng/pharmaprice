// Optional: polishes the generated email with Claude. Needs ANTHROPIC_API_KEY in Vercel settings.
const SYSTEM = `You edit B2B pharmaceutical trade emails written by a sales or purchasing professional.
Rewrite the email following the user's instruction.
Rules:
- Keep every number, currency, unit, percentage, Incoterm, HS code, date placeholder and [bracketed placeholder] exactly as written.
- Do not add prices, facts, claims, promises or company details that are not in the original.
- Keep it a plain-text email that starts with "Subject:".
- Output only the rewritten email.`;

export const config = { maxDuration: 60 };

// Best-effort abuse protection: same-site requests only, a small per-IP budget per warm instance,
// and a short output cap. Also set a monthly spend limit for the key in the Anthropic Console.
const hits = new Map();
function limited(ip) {
  const now = Date.now(), win = 10 * 60 * 1000, max = 20;
  const arr = (hits.get(ip) || []).filter(t => now - t < win);
  arr.push(now); hits.set(ip, arr);
  if (hits.size > 5000) hits.clear();
  return arr.length > max;
}
function sameSite(req) {
  const host = req.headers && (req.headers['x-forwarded-host'] || req.headers.host);
  const src = req.headers && (req.headers.origin || req.headers.referer);
  if (!host || !src) return false;
  try { return new URL(src).host === host; } catch (e) { return false; }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'method' });
  if (!sameSite(req)) return res.status(403).json({ error: 'forbidden' });
  const ip = String((req.headers && (req.headers['x-forwarded-for'] || '')) || '').split(',')[0].trim() || 'unknown';
  if (limited(ip)) return res.status(429).json({ error: 'rate_limited' });
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return res.status(501).json({ error: 'not_configured' });
  const { text, instruction } = req.body || {};
  if (typeof text !== 'string' || !/^\s*Subject:/i.test(text) || text.length > 6000 || typeof instruction !== 'string' || instruction.length > 500) {
    return res.status(400).json({ error: 'bad_input' });
  }
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      signal: AbortSignal.timeout(45000),
      headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({
        model: process.env.ANTHROPIC_MODEL || 'claude-sonnet-5-5',
        max_tokens: 1600,
        system: SYSTEM,
        messages: [{ role: 'user', content: `Instruction: ${instruction}\n\n<email>\n${text}\n</email>` }]
      })
    });
    const j = await r.json();
    if (!r.ok) return res.status(502).json({ error: 'upstream', detail: j && j.error && j.error.type });
    const out = (j.content || []).filter(b => b.type === 'text').map(b => b.text).join('').trim();
    return res.status(200).json({ text: out });
  } catch (e) {
    return res.status(502).json({ error: 'fetch_failed' });
  }
}
