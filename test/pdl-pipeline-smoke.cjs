// One live Azure Security Engineer pipeline run.
// Run via: railway run --service hospitable-trust node test/pdl-pipeline-smoke.cjs
// Auth pulled from injected env; never printed. Output strips PII; emits aggregates only.

const USER = process.env.INTERNAL_USER || 'sola';
const PASS = process.env.INTERNAL_PASSWORD || '';
if (!PASS) { console.log(JSON.stringify({ ok: false, reason: 'INTERNAL_PASSWORD not in env' })); process.exit(1); }

const BASE = 'https://app.solascholars.com';
const auth = 'Basic ' + Buffer.from(`${USER}:${PASS}`).toString('base64');

const body = {
  company: 'Sola Scholars PDL Smoke',
  role: 'Azure Security Engineer',
  skills: ['Azure', 'Sentinel', 'KQL', 'Defender', 'IAM', 'Incident Response'],
  location: 'Remote',
  seniority: 'Mid',
};

(async () => {
  let res, j = null;
  try {
    res = await fetch(`${BASE}/api/pipeline/run`, {
      method: 'POST',
      headers: { 'Authorization': auth, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch (e) {
    console.log(JSON.stringify({ ok: false, error: 'fetch threw', message: String(e && e.message || e).slice(0, 200) }));
    process.exit(2);
  }
  try { j = await res.json(); } catch {}

  if (!res.ok) {
    console.log(JSON.stringify({ ok: false, httpStatus: res.status, body: (j && (j.error || JSON.stringify(j).slice(0,200))) || '' }, null, 2));
    process.exit(3);
  }

  // Strip PII: never emit candidate names/emails/urls. Only counts + per-source stats.
  const cands = Array.isArray(j.report && j.report.shortlist) ? j.report.shortlist : [];
  const allCands = Array.isArray(j.report && j.report.allCandidates) ? j.report.allCandidates : [];

  // We need candidate-level visibility to check PDL → LinkedIn URL → verified.
  // Re-fetch via authenticated /api/candidates filtered by pipelineRunId.
  const runId = j.report && j.report.pipelineRunId || j.runId || '';
  let pdlStats = { pdlCandidates: 0, withLinkedInUrl: 0, verifiedStatus: 0, finalEligible: 0 };
  if (runId) {
    try {
      const r2 = await fetch(`${BASE}/api/candidates?pipelineRunId=${encodeURIComponent(runId)}`, { headers: { 'Authorization': auth } });
      if (r2.ok) {
        const cList = await r2.json();
        const arr = Array.isArray(cList) ? cList : (cList.candidates || []);
        for (const c of arr) {
          if (c.source === 'PDL') {
            pdlStats.pdlCandidates++;
            if (typeof c.linkedinUrl === 'string' && /linkedin\.com\/in\//i.test(c.linkedinUrl)) pdlStats.withLinkedInUrl++;
            if (c.identityVerificationStatus === 'verified') pdlStats.verifiedStatus++;
            if (c.scoutDecision === 'accepted' && c.identityVerificationStatus === 'verified') pdlStats.finalEligible++;
          }
        }
      } else {
        pdlStats.error = `candidates fetch HTTP ${r2.status}`;
      }
    } catch (e) {
      pdlStats.error = String(e && e.message || e).slice(0, 200);
    }
  }

  // Top rejection reasons aggregated across sources.
  const reasons = {};
  const rrbs = j.rejectedReasonsBySource || (j.report && j.report.rejectedReasonsBySource) || {};
  for (const [src, m] of Object.entries(rrbs || {})) {
    for (const [why, n] of Object.entries(m || {})) {
      reasons[`${src}: ${why}`] = (reasons[`${src}: ${why}`] || 0) + n;
    }
  }
  const topReasons = Object.entries(reasons).sort((a, b) => b[1] - a[1]).slice(0, 8);

  const report = {
    ok: true,
    httpStatus: res.status,
    pipelineRunId: runId || null,
    sourcedRaw: j.sourcedRaw ?? null,
    apolloRaw: j.apolloRaw ?? null,
    pdlRaw: j.pdlRaw ?? null,
    firecrawlRaw: j.firecrawlRaw ?? null,
    githubRaw: j.githubRaw ?? null,
    adzunaRaw: j.adzunaRaw ?? null,
    acceptedCandidates: j.report && j.report.acceptedCandidates !== undefined ? j.report.acceptedCandidates : (j.acceptedCandidates ?? null),
    reviewCandidates: j.reviewCandidates ?? null,
    rejectedCandidates: j.rejectedCandidates ?? null,
    visible: j.visible ?? null,
    dropped: j.dropped ?? null,
    finalShortlistCount: cands.length,
    acceptedBySource: j.acceptedBySource || null,
    reviewBySource: j.reviewBySource || null,
    rejectedBySource: j.rejectedBySource || null,
    topRejectionReasons: topReasons,
    pdlVerification: pdlStats,
    verifiedOnlyGate: 'pdlCandidates with verified status + accepted decision === finalEligible (PDL side)',
  };
  console.log(JSON.stringify(report, null, 2));
})();
