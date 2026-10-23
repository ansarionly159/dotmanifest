// fetch-fmcsa-data.js
// Finds carriers whose operating authority was newly GRANTED on a given day
// (FMCSA "Motus AuthHist - All With History"), then fills in company name,
// phone, email, city, fleet size from the Company Census (matched by DOT #).
//
// Each carrier is saved under the day its authority was granted, so the
// "Registered" column is the real grant date. Every run re-checks the last
// few days to catch late-posted records. If old-format data is found, it is
// removed and the last 30 days are rebuilt automatically.

const https = require('https');
const fs = require('fs');
const path = require('path');

const AUTH_DATASET = 'yu5v-wbh6';     // Motus AuthHist - All With History
const CENSUS_DATASET = 'az4n-8mr2';   // Company Census File
const APP_TOKEN = process.env.SOCRATA_APP_TOKEN || '';
const DATA_VERSION = 2;

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

function shiftDate(isoDate, days) {
  const d = new Date(isoDate + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

// All authorities GRANTED (and currently Active in the record) on one day.
async function fetchGrantsForDate(iso) {
  const compact = iso.replace(/-/g, '');
  const rest = `upper(reason)='GRANTED' AND upper(op_auth_status)='ACTIVE'`;
  let rows = await getJson(socrataUrl(AUTH_DATASET, {
    $where: `status_change_date='${compact}' AND ${rest}`, $limit: 5000
  }));
  if (!Array.isArray(rows)) {
    // column might be numeric - retry without quotes
    rows = await getJson(socrataUrl(AUTH_DATASET, {
      $where: `status_change_date=${compact} AND ${rest}`, $limit: 5000
    }));
  }
  if (!Array.isArray(rows)) throw new Error('AuthHist error: ' + JSON.stringify(rows).slice(0, 300));
  return rows;
}

async function fetchCensus(dots) {
  const out = {};
  const select = 'dot_number,legal_name,phone,email_address,phy_city,phy_state,power_units,docket1prefix,docket1,docket1_status_code';
  for (let i = 0; i < dots.length; i += 80) {
    const chunk = dots.slice(i, i + 80);
    let rows = await getJson(socrataUrl(CENSUS_DATASET, {
      $select: select, $where: `dot_number in (${chunk.join(',')})`, $limit: 1000
    }));
    if (!Array.isArray(rows)) {
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

async function run(today) {
  const outFile = path.join(__dirname, 'data', 'carriers.json');
  let existing = fs.existsSync(outFile) ? JSON.parse(fs.readFileSync(outFile)) : [];

  const hasOldFormat = existing.some(c => c.v !== DATA_VERSION);
  if (hasOldFormat) {
    existing = existing.filter(c => c.v === DATA_VERSION);
    console.log('Old-format records removed. Rebuilding the last 30 days.');
  }
  const lookback = hasOldFormat ? 30 : 3;
  const dates = Array.from({ length: lookback + 1 }, (_, i) => shiftDate(today, i));
  console.log(`Checking grant dates: ${dates[dates.length - 1]} to ${dates[0]}`);

  const typeCounts = {};
  const seenDot = new Set();
  const grants = [];
  for (const iso of dates) {
    const rows = await fetchGrantsForDate(iso);
    let kept = 0;
    for (const r of rows) {
      const type = (r.op_auth_type || '').trim();
      typeCounts[type] = (typeCounts[type] || 0) + 1;
      const docket = (r.docket_number || '').trim().toUpperCase();
      if (!docket.startsWith('MC')) continue;                       // carriers only
      if (!type.toLowerCase().includes('motor carrier')) continue;  // not brokers
      const dot = parseInt(r.usdot_number, 10);
      if (!dot || seenDot.has(dot)) continue;                       // one row per carrier
      seenDot.add(dot);
      grants.push({ docket, dot, date: iso });
      kept++;
    }
    console.log(`${iso}: ${rows.length} grants in file, ${kept} motor carriers kept`);
  }
  console.log('Authority types seen:', JSON.stringify(typeCounts));

  const census = await fetchCensus(grants.map(g => g.dot));

  const mapped = [];
  let noCensus = 0, inactive = 0;
  for (const g of grants) {
    const info = census[String(g.dot)];
    if (!info || !info.legal_name) { noCensus++; continue; }
    const sameMc = (info.docket1prefix || '').toUpperCase() === 'MC' &&
      String(info.docket1 || '').replace(/\D/g, '') === g.docket.replace(/\D/g, '');
    const code = (info.docket1_status_code || '').toUpperCase();
    if (sameMc && code.startsWith('I')) { inactive++; continue; }   // no longer active
    mapped.push({
      company_name: info.legal_name,
      phone: formatPhone(info.phone),
      email: info.email_address || '',
      dot_number: String(g.dot),
      mc_number: g.docket,
      city: info.phy_city || '',
      state: info.phy_state || '',
      status: 'Active',
      equipment_count: info.power_units || 0,
      registration_date: g.date,
      v: DATA_VERSION
    });
  }
  console.log(`Saved ${mapped.length} carriers (${noCensus} skipped: no census match, ${inactive} skipped: not active now)`);

  const merged = [...existing.filter(c => !dates.includes(c.registration_date)), ...mapped];
  fs.writeFileSync(outFile, JSON.stringify(merged, null, 2));
}

const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
run(today).catch(err => { console.error('Fetch failed:', err.message); process.exit(1); });
