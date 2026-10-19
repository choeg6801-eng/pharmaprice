// Proxy to UN Comtrade. One call = one period, imports and exports together.
// Without COMTRADE_KEY it uses the free public preview API (max 500 rows per call).
const FREQ = new Set(['M', 'A']);

async function availability(r, f, key, res) {
  // Which periods UN Comtrade has published for this reporter (all products). Used to pick the latest N periods.
  const base = key ? `https://comtradeapi.un.org/data/v1/getDa/C/${f}/HS` : `https://comtradeapi.un.org/public/v1/getDa/C/${f}/HS`;
  const qs = new URLSearchParams({ reportercode: r });
  if (key) qs.set('subscription-key', key);
  const resp = await fetch(`${base}?${qs}`, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(15000) });
  if (!resp.ok) return res.status(502).json({ error: 'upstream', status: resp ? resp.status : 0 });
  const j = await resp.json();
  const periods = Array.from(new Set((j.data || []).map(d => String(d.period)))).sort();
  res.setHeader('Cache-Control', 'public, s-maxage=43200, stale-while-revalidate=604800');
  return res.status(200).json({ ok: true, periods });
}

export const config = { maxDuration: 60 };

export default async function handler(req, res) {
  const { r, cmd, p, f = 'M', da } = req.query || {};
  if (da === '1') {
    if (!/^\d{1,4}$/.test(r || '') || !FREQ.has(f)) return res.status(400).json({ error: 'bad_params' });
    try { return await availability(r, f, process.env.COMTRADE_KEY, res); } catch (e) { return res.status(502).json({ error: 'fetch_failed' }); }
  }
  if (!/^\d{1,4}$/.test(r || '') || !/^\d{2,6}$/.test(cmd || '') || !/^\d{4}(\d{2})?$/.test(p || '') || !FREQ.has(f)) {
    return res.status(400).json({ error: 'bad_params' });
  }
  const key = process.env.COMTRADE_KEY;
  const base = key
    ? `https://comtradeapi.un.org/data/v1/get/C/${f}/HS`
    : `https://comtradeapi.un.org/public/v1/preview/C/${f}/HS`;
  const qs = new URLSearchParams({
    reporterCode: r, period: p, cmdCode: cmd, flowCode: 'M,X',
    partner2Code: '0', motCode: '0', customsCode: 'C00', includeDesc: 'true'
  });
  if (key) qs.set('subscription-key', key);
  try {
    let resp;
    for (let i = 0; i < 3; i++) {
      try {
        resp = await fetch(`${base}?${qs}`, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(15000) });
      } catch (e) { resp = null; if (i === 2) throw e; }
      // The free preview API throttles bursts: retry on 429 and on temporary 5xx errors.
      if (resp && resp.status !== 429 && resp.status < 500) break;
      if (i < 2) await new Promise(ok => setTimeout(ok, 2000 * (i + 1)));
    }
    if (!resp || !resp.ok) return res.status(resp && resp.status === 429 ? 429 : 502).json({ error: 'upstream', status: resp ? resp.status : 0 });
    const j = await resp.json();
    const data = (j.data || []).map(d => ({
      period: String(d.period), flow: d.flowCode, pc: d.partnerCode, pi: d.partnerISO, pd: d.partnerDesc,
      nw: d.netWgt, nwe: d.isNetWgtEstimated, q: d.qty, qu: d.qtyUnitAbbr, qe: d.isQtyEstimated,
      cif: d.cifvalue, fob: d.fobvalue, pv: d.primaryValue
    }));
    // Do not cache error responses or empty answers that came with an error message.
    res.setHeader('Cache-Control', j.error ? 'no-store' : data.length ? 'public, s-maxage=86400, stale-while-revalidate=604800' : 'public, s-maxage=3600');
    return res.status(200).json({ ok: true, period: p, count: data.length, truncated: !key && (j.count || data.length) >= 500, data, error: j.error || '' });
  } catch (e) {
    return res.status(502).json({ error: 'fetch_failed' });
  }
}
