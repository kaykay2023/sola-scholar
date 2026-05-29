// PDL smoke test — 1 live API call, no secrets printed.
// Run via: railway run node test/pdl-smoke.cjs
// Forces a minimal POST /v5/person/search with size=1.

const hasKey = !!process.env.PDL_API_KEY;
if (!hasKey) {
  console.log(JSON.stringify({ ok: false, reason: 'PDL_API_KEY not present in environment' }));
  process.exit(1);
}

(async () => {
  const body = {
    query: { bool: { must: [{ match: { job_title: 'Azure Security Engineer' } }] } },
    size: 1,
  };
  let res;
  try {
    res = await fetch('https://api.peopledatalabs.com/v5/person/search', {
      method: 'POST',
      headers: {
        'X-Api-Key': process.env.PDL_API_KEY,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      body: JSON.stringify(body),
    });
  } catch (e) {
    console.log(JSON.stringify({ ok: false, error: 'fetch threw', message: String(e && e.message || e).slice(0, 200) }));
    process.exit(2);
  }

  const status = res.status;
  let json = null;
  try { json = await res.json(); } catch {}

  // Redact: only emit shape, not content.
  const report = {
    ok: res.ok,
    httpStatus: status,
    endpoint: '/v5/person/search',
    apiCallsMade: 1,
    responseKeys: json ? Object.keys(json) : [],
    recordCount: Array.isArray(json && json.data) ? json.data.length : 0,
    total: (json && json.total) || null,
    pdlStatus: (json && json.status) || null,
  };

  // If we got a record, report only WHICH fields are present (not values).
  if (Array.isArray(json && json.data) && json.data.length > 0) {
    const rec = json.data[0] || {};
    report.fieldsPresent = {
      linkedin_url: !!rec.linkedin_url,
      job_title: !!rec.job_title,
      job_company_name: !!rec.job_company_name,
      location_country: !!rec.location_country,
      location_locality: !!rec.location_locality,
      full_name: !!rec.full_name,
      emails: Array.isArray(rec.emails) ? rec.emails.length : (rec.emails ? 1 : 0),
      phone_numbers: Array.isArray(rec.phone_numbers) ? rec.phone_numbers.length : (rec.phone_numbers ? 1 : 0),
      skills: Array.isArray(rec.skills) ? rec.skills.length : 0,
    };
  }

  // Surface error reason WITHOUT echoing key.
  if (!res.ok && json && (json.error || json.message)) {
    const err = json.error || json;
    report.pdlError = {
      type: err.type || null,
      message: String(err.message || '').slice(0, 200),
    };
  }

  console.log(JSON.stringify(report, null, 2));
})();
