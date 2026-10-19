// Proxy to UN Comtrade.
// - Without COMTRADE_KEY: free public preview API (max 500 rows per call, one period per call).
// - With COMTRADE_KEY: official data API (up to 100,000 rows per call, several periods per call).
// Query: r=reporter code, cmd=HS code, p=period or comma list (YYYY or YYYYMM, up to 12),
//        f=M|A, optional pc=partner code (mirror checks), fl=M|X|M,X, mot=transport mode code.
const FREQ = new Set(['M', 'A']);
const FLOWS = new Set(['M', 'X', 'M,X']);
const MOTS = new Set(['0', '1000', '2000', '2100', '3000', '9200']);

async function getJSON(url) {
  let resp;
  // Two attempts of up to 25 s each fit inside the 60 s function limit. Multi-period answers from the
  // data API can take longer than a single month, so the first attempt gets the full window.
  for (let i = 0; i < 2; i++) {
    try {
      resp = await fetch(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(25000) });
    } catch (e) { resp = null; if (i === 1) throw e; }
    // The API throttles bursts: retry on 429 and on temporary 5xx errors.
    if (resp && resp.status !== 429 && resp.status < 500) break;
    if (i < 1) await new Promise(ok => setTimeout(ok, 2500));
  }
  return resp;
}

async function availability(r, f, key, res) {
  // Which periods UN Comtrade has published for this reporter (all products), and whether the
  // reporter publishes a breakdown by mode of transport for that period.
  const base = key ? `https://comtradeapi.un.org/data/v1/getDa/C/${f}/HS` : `https://comtradeapi.un.org/public/v1/getDa/C/${f}/HS`;
  const qs = new URLSearchParams({ reportercode: r });
  if (key) qs.set('subscription-key', key);
  const resp = await getJSON(`${base}?${qs}`);
  if (!resp || !resp.ok) return res.status(502).json({ error: 'upstream', status: resp ? resp.status : 0 });
  const j = await resp.json();
  const motExt = {};
  (j.data || []).forEach(d => { const k = String(d.period); motExt[k] = motExt[k] || !!d.isExtendedMotCode; });
  const periods = Object.keys(motExt).sort();
  res.setHeader('Cache-Control', 'public, s-maxage=43200, stale-while-revalidate=604800');
  return res.status(200).json({ ok: true, periods, motExt });
}

export const config = { maxDuration: 60 };

export default async function handler(req, res) {
  const { r, cmd, p, f = 'M', da, pc, fl = 'M,X', mot = '0' } = req.query || {};
  const key = process.env.COMTRADE_KEY;
  if (da === '1') {
    if (!/^\d{1,4}$/.test(r || '') || !FREQ.has(f)) return res.status(400).json({ error: 'bad_params' });
    try { return await availability(r, f, key, res); } catch (e) { return res.status(502).json({ error: 'fetch_failed' }); }
  }
  const per = String(p || '').split(',').filter(Boolean);
  const perOk = per.length >= 1 && per.length <= 12 && per.every(x => (f === 'A' ? /^\d{4}$/ : /^\d{6}$/).test(x));
  if (!/^\d{1,4}$/.test(r || '') || !/^\d{2,6}$/.test(cmd || '') || !perOk || !FREQ.has(f) ||
      (pc != null && pc !== '' && !/^\d{1,4}$/.test(pc)) || !FLOWS.has(fl) || !MOTS.has(String(mot))) {
    return res.status(400).json({ error: 'bad_params' });
  }
  if (per.length > 1 && !key) return res.status(400).json({ error: 'multi_period_needs_key' });
  const base = key ? `https://comtradeapi.un.org/data/v1/get/C/${f}/HS` : `https://comtradeapi.un.org/public/v1/preview/C/${f}/HS`;
  const maxRecords = key ? 100000 : 500;
  const qs = new URLSearchParams({
    reporterCode: r, period: per.join(','), cmdCode: cmd, flowCode: fl,
    partner2Code: '0', motCode: String(mot), customsCode: 'C00', includeDesc: 'true', maxRecords: String(maxRecords)
  });
  if (pc) qs.set('partnerCode', pc);
  if (key) qs.set('subscription-key', key);
  try {
    const resp = await getJSON(`${base}?${qs}`);
    if (!resp || !resp.ok) return res.status(resp && resp.status === 429 ? 429 : 502).json({ error: 'upstream', status: resp ? resp.status : 0 });
    const j = await resp.json();
    const data = (j.data || []).map(d => ({
      period: String(d.period), flow: d.flowCode, pc: d.partnerCode, pi: d.partnerISO, pd: d.partnerDesc,
      nw: d.netWgt, nwe: d.isNetWgtEstimated, q: d.qty, qu: d.qtyUnitAbbr, qe: d.isQtyEstimated,
      cif: d.cifvalue, fob: d.fobvalue, pv: d.primaryValue, mot: d.motCode
    }));
    // Do not cache error responses; cache empty answers only briefly.
    res.setHeader('Cache-Control', j.error ? 'no-store' : data.length ? 'public, s-maxage=86400, stale-while-revalidate=604800' : 'public, s-maxage=3600');
    return res.status(200).json({ ok: true, period: per.join(','), count: data.length, truncated: (j.count || data.length) >= maxRecords, data, error: j.error || '' });
  } catch (e) {
    return res.status(502).json({ error: 'fetch_failed' });
  }
}
