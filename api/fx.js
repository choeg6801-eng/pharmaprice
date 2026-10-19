// Daily reference exchange rates from ExchangeRate-API (open access, no key).
// Attribution is shown in the app: "Rates By Exchange Rate API" (https://www.exchangerate-api.com).
const KEEP = ['KRW', 'EUR', 'CNY', 'JPY', 'INR', 'CHF', 'GBP', 'VND', 'BRL'];
export const config = { maxDuration: 60 };

export default async function handler(req, res) {
  try {
    const r = await fetch('https://open.er-api.com/v6/latest/USD', { signal: AbortSignal.timeout(10000) });
    if (!r.ok) return res.status(502).json({ result: 'error', error: 'upstream ' + r.status });
    const j = await r.json();
    if (j.result !== 'success' || !j.rates) return res.status(502).json({ result: 'error', error: 'bad_response' });
    const rates = {};
    KEEP.forEach(k => { if (typeof j.rates[k] === 'number') rates[k] = j.rates[k]; });
    // Rates change once a day; let the edge cache them for an hour and serve stale for a day.
    res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=86400');
    return res.status(200).json({ result: 'success', base: 'USD', rates, time_last_update_utc: j.time_last_update_utc, time_next_update_utc: j.time_next_update_utc, provider: 'https://www.exchangerate-api.com' });
  } catch (e) {
    return res.status(502).json({ result: 'error', error: 'fetch_failed' });
  }
}
