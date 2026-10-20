// Optional live lookup of the MFDS DMF register (data.go.kr dataset 15057075).
// Needs DATA_GO_KR_KEY (a free data.go.kr service key). Without it the site uses the bundled snapshot.
// Query: q = Korean ingredient name.
const ENDPOINT = 'https://apis.data.go.kr/1471000/MdcDmfInfoService01/getMdcDmfList01';
export const config = { maxDuration: 30 };

// Only answer requests coming from this site, so others cannot use up the service-key quota.
function sameSite(req) {
  const host = req.headers && (req.headers['x-forwarded-host'] || req.headers.host);
  const src = req.headers && (req.headers.origin || req.headers.referer);
  if (!host || !src) return false;
  try { return new URL(src).host === host; } catch (e) { return false; }
}

export default async function handler(req, res) {
  const raw = process.env.DATA_GO_KR_KEY;
  if (!raw) return res.status(404).json({ error: 'no_key' });
  if (!sameSite(req)) return res.status(403).json({ error: 'forbidden' });
  const q = String((req.query || {}).q || '').trim();
  if (!q || q.length > 60 || /[<>"'`;]/.test(q)) return res.status(400).json({ error: 'bad_params' });
  let key = raw;
  try { key = decodeURIComponent(raw); } catch (e) { /* already decoded */ }
  const items = [];
  const deadline = Date.now() + 18000; // stay well inside maxDuration and the client's 25 s wait
  try {
    for (let page = 1; page <= 5; page++) {
      const left = deadline - Date.now();
      if (left < 1500) break;
      const qs = new URLSearchParams({ serviceKey: key, pageNo: String(page), numOfRows: '100', type: 'json', ingr_kor_name: q });
      const r = await fetch(`${ENDPOINT}?${qs}`, { signal: AbortSignal.timeout(Math.min(8000, left)) });
      if (!r.ok) return res.status(502).json({ error: 'upstream', status: r.status });
      let j;
      try { j = JSON.parse(await r.text()); } catch (e) { return res.status(502).json({ error: 'bad_upstream' }); }
      const header = (j.response && j.response.header) || j.header || {};
      if (header.resultCode && header.resultCode !== '00') return res.status(502).json({ error: 'upstream', status: header.resultCode });
      const body = (j.response && j.response.body) || j.body || {};
      let list = body.items;
      if (list && !Array.isArray(list)) list = list.item ? (Array.isArray(list.item) ? list.item : [list.item]) : [];
      (list || []).forEach(x => items.push({
        i: (x.INGR_KOR_NAME || '').trim(), e: (x.ENTP_NAME || '').trim(), m: (x.MNFCTR_NAME || '').trim(),
        c: (x.MANUF_COUNTRY_CODE_NM || '').trim(), d: x.DMF_PERMIT_DATE || '', no: x.DMF_PERMIT_NO || '', n: x.NOTICE_CODE || ''
      }));
      const total = Number(body.totalCount || 0);
      if (!list || list.length < 100 || items.length >= total) break;
    }
  } catch (e) {
    return res.status(502).json({ error: 'fetch_failed' });
  }
  res.setHeader('Cache-Control', 'public, s-maxage=86400, stale-while-revalidate=604800');
  return res.status(200).json({ ok: true, fetchedAt: new Date().toISOString(), count: items.length, items });
}
