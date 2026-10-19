// fetch-fmcsa-data.js
// Daily job: finds carriers whose operating authority is ACTIVE in FMCSA's
// "Motus Carrier" daily-difference file, then fills in company name, phone,
// email, city, fleet size from FMCSA's Company Census file (matched by DOT #).
//
// Motus Carrier (nakq-58th): authority records - often has blank names/phones.
// Company Census (az4n-8mr2): full carrier profiles.

const https = require('https');
const fs = require('fs');
const path = require('path');

const MOTUS_DATASET = 'nakq-58th';
const CENSUS_DATASET = 'az4n-8mr2';
const APP_TOKEN = process.env.SOCRATA_APP_TOKEN || '';

function getJson(url, attempts = 3) {
  return new Promise((resolve, reject) => {
    const tryOnce = n => {
      const retry = fallback => {
        if (n < attempts) return setTimeout(() => tryOnce(n + 1), 1500 * n);
        fallback();
      };
      https.get(url, res => {
        let data = '';
        res.on('data', c => (data += c));
        res.on('end', () => {
          if (res.statusCode >= 500) return retry(() => reject(new Error('Server error ' + res.statusCode)));
          try { resolve(JSON.parse(data)); }
          catch (e) { retry(() => reject(new Error('Bad response: ' + data.slice(0, 200)))); }
        });
      }).on('error', err => retry(() => reject(err)));
    };
    tryOnce(1);
  });
}

function socrataUrl(dataset, params) {
  const qs = Object.entries(params).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
  return `https://data.transportation.gov/resource/${dataset}.json?${qs}` +
    (APP_TOKEN ? `&$$app_token=${APP_TOKEN}` : '');
}

function formatPhone(raw) {
  const d = String(raw || '').replace(/\D/g, '');
  if (d.length === 10) return `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`;
  return raw || '';
}

async function fetchCensus(dots) {
  const out = {};
  const select = 'dot_number,legal_name,phone,email_address,phy_city,phy_state,power_units,add_date';
  for (let i = 0; i < dots.length; i += 80) {
    const chunk = dots.slice(i, i + 80);
    let rows = await getJson(socrataUrl(CENSUS_DATASET, {
      $select: select, $where: `dot_number in (${chunk.join(',')})`, $limit: 1000
    }));
    if (!Array.isArray(rows)) {
      // dot_number may be stored as text - retry with quotes
      rows = await getJson(socrataUrl(CENSUS_DATASET, {
        $select: select, $where: `dot_number in (${chunk.map(d => `'${d}'`).join(',')})`, $limit: 1000
      }));
    }
    if (!Array.isArray(rows)) {
      console.warn('Census lookup failed for a batch:', JSON.stringify(rows).slice(0, 200));
      continue;
    }
    for (const r of rows) out[String(parseInt(r.dot_number, 10))] = r;
  }
  return out;
}

async function run(targetDate) {
  console.log(`Fetching Motus Carrier daily file for ${targetDate}...`);
  const rows = await getJson(socrataUrl(MOTUS_DATASET, { $limit: 50000 }));
  if (!Array.isArray(rows)) throw new Error('Motus response error: ' + JSON.stringify(rows).slice(0, 300));
  console.log(`Motus rows: ${rows.length}`);

  const statusCounts = {};
  rows.forEach(r => {
    const s = (r.op_auth_status || '(blank)').trim().toUpperCase();
    statusCounts[s] = (statusCounts[s] || 0) + 1;
  });
  console.log('Status values found:', JSON.stringify(statusCounts));

  const seen = new Set();
  const candidates = [];
  for (const r of rows) {
    const status = (r.op_auth_status || '').trim().toUpperCase();
    const docket = (r.docket_number || '').trim().toUpperCase();
    if (!docket.startsWith('MC')) continue;                 // carriers only (no FF/MX)
    if (status !== 'ACTIVE' && status !== 'A') continue;    // exact match, not "INACTIVE"
    if (seen.has(docket)) continue;                         // one row per MC number
    const dot = parseInt(r.usdot_number, 10);
    if (!dot) continue;
    seen.add(docket);
    candidates.push({ docket, dot });
  }
  console.log(`Active MC carriers in file: ${candidates.length}`);

  const census = await fetchCensus(candidates.map(c => c.dot));

  const mapped = [];
  for (const c of candidates) {
    const info = census[String(c.dot)];
    if (!info || !info.legal_name) continue;                // can't verify -> skip
    mapped.push({
      company_name: info.legal_name,
      phone: formatPhone(info.phone),
      email: info.email_address || '',
      dot_number: String(c.dot),
      mc_number: c.docket,
      city: info.phy_city || '',
      state: info.phy_state || '',
      status: 'Active',
      equipment_count: info.power_units || 0,
      registration_date: targetDate
    });
  }
  console.log(`Matched with census (saved): ${mapped.length}`);

  const outFile = path.join(__dirname, 'data', 'carriers.json');
  const existing = fs.existsSync(outFile) ? JSON.parse(fs.readFileSync(outFile)) : [];
  const merged = [...existing.filter(c => c.registration_date !== targetDate), ...mapped];
  fs.writeFileSync(outFile, JSON.stringify(merged, null, 2));
  console.log(`Saved ${mapped.length} carriers for ${targetDate}`);
}

const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
run(today).catch(err => { console.error('Fetch failed:', err.message); process.exit(1); });
