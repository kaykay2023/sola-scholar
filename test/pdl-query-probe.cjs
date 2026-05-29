// Probe PDL with the exact body shape pdlPersonSearch would send for the
// failed Azure SE run. Reports response shape only; no PII.
// Run via: railway run --service hospitable-trust node test/pdl-query-probe.cjs

if (!process.env.PDL_API_KEY) {
  console.log(JSON.stringify({ ok: false, reason: 'PDL_API_KEY not in env' }));
  process.exit(1);
}

// Match runScout call: role=need.title, keywords=requiredSkills.slice(0,5).join(' ').
const role = 'Azure Security Engineer';
const keywordsStr = ['Azure', 'Sentinel', 'KQL', 'Defender', 'IAM'].join(' ');

const must = [{ match: { job_title: role } }];
const should = keywordsStr.split(/\s+/).map(s => s.trim()).filter(Boolean).map(kw => ({ match: { skills: kw } }));
const bool = { must };
if (should.length) {
  bool.should = should;
  bool.minimum_should_match = 1;
}
const body = { query: { bool }, size: 25 };

(async () => {
  let res, j = null;
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
  try { j = await res.json(); } catch {}

  const report = {
    httpStatus: res.status,
    requestBodyShape: {
      query: {
        bool: {
          must_count: must.length,
          must_clauses: must.map(c => Object.keys(c.match || {})),
          should_count: should.length,
          should_clauses: should.map(c => Object.keys(c.match || {})),
          minimum_should_match: bool.minimum_should_match,
        },
      },
      size: body.size,
    },
    requestBodyRaw: body,  // skill names + role are not secret; full request shape for diagnosis
    responseKeys: j ? Object.keys(j) : [],
    pdlBodyStatus: (j && j.status) || null,
    total: (j && j.total) ?? null,
    recordCount: Array.isArray(j && j.data) ? j.data.length : 0,
    pdlError: (j && (j.error || j.message)) ? {
      type: (j.error && j.error.type) || null,
      message: String((j.error && j.error.message) || j.message || '').slice(0, 300),
    } : null,
  };

  if (Array.isArray(j && j.data) && j.data.length > 0) {
    const rec = j.data[0] || {};
    report.firstRecordFieldsPresent = {
      linkedin_url: !!rec.linkedin_url,
      job_title: !!rec.job_title,
      job_company_name: !!rec.job_company_name,
      location_country: !!rec.location_country,
      skills_count: Array.isArray(rec.skills) ? rec.skills.length : 0,
    };
  }

  console.log(JSON.stringify(report, null, 2));
})();
