export default function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.status(200).json({ ok: true, ai: !!process.env.ANTHROPIC_API_KEY, comtradeKey: !!process.env.COMTRADE_KEY });
}
