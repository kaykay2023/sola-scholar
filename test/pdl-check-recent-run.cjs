// Check whether the most-recent /api/pipeline/run already executed
// server-side despite the client fetch reporting "fetch failed".
// Run via: railway run --service hospitable-trust node test/pdl-check-recent-run.cjs
//
// Strategy: read /api/activity-logs + /api/client-reports + /api/hiring-needs
// and report the most recent Azure SE need/run.

const USER = process.env.INTERNAL_USER || 'sola';
const PASS = process.env.INTERNAL_PASSWORD || '';
if (!PASS) { console.log(JSON.stringify({ ok: false, reason: 'INTERNAL_PASSWORD not in env' })); process.exit(1); }
const BASE = 'https://app.solascholars.com';
const auth = 'Basic ' + Buffer.from(`${USER}:${PASS}`).toString('base64');

async function getJSON(path) {
  const res = await fetch(`${BASE}${path}`, { headers: { 'Authorization': auth } });
  let j = null; try { j = await res.json(); } catch {}
  return { status: res.status, json: j };
}

(async () => {
  const [logs, needs, reports, cands] = await Promise.all([
    getJSON('/api/activity-logs'),
    getJSON('/api/hiring-needs'),
    getJSON('/api/client-reports'),
    getJSON('/api/candidates'),
  ]);

  const cutoff = Date.now() - 30 * 60 * 1000; // last 30 minutes
  const recent = (logs.json || []).filter(l => {
    const t = new Date(l.at || l.timestamp || 0).getTime();
    return t && t > cutoff;
  });
  const azureNeeds = (needs.json || []).filter(n => /azure security/i.test(n.title || ''));
  const recentAzure = azureNeeds
    .map(n => ({ id: n.id, title: n.title, createdAt: n.createdAt, lastScoutStats: n.lastScoutStats }))
    .filter(n => {
      const t = new Date(n.createdAt || 0).getTime();
      return t && t > cutoff;
    });
  const azureReports = (reports.json || []).filter(r => /azure security/i.test(r.role || r.title || ''));

  // Recent PDL candidates from any run in cutoff window
  const recentPdlCands = (cands.json || []).filter(c => {
    if (c.source !== 'PDL') return false;
    const t = new Date(c.createdAt || 0).getTime();
    return t && t > cutoff;
  });

  // Sum activity log signals about PDL behavior
  const pdlLogs = recent.filter(l => /pdl/i.test(l.message || '') || (l.meta && (l.meta.source === 'pdl' || l.meta.endpoint?.includes('/v5/'))));

  const report = {
    activityLogsTotalRecent: recent.length,
    pdlActivityLogCount: pdlLogs.length,
    pdlActivityLogSamples: pdlLogs.slice(0, 5).map(l => ({
      at: l.at, agent: l.agent, message: (l.message || '').slice(0, 240), status: l.status,
      metaSummary: l.meta ? {
        source: l.meta.source || null,
        reason: l.meta.reason || null,
        status: l.meta.status ?? null,
        endpoint: l.meta.endpoint || null,
        returned: l.meta.returned ?? null,
      } : null,
    })),
    recentAzureNeeds: recentAzure,
    azureReportsCount: azureReports.length,
    mostRecentAzureReport: azureReports.length ? {
      id: azureReports[0].id,
      role: azureReports[0].role,
      createdAt: azureReports[0].createdAt,
      shortlistCount: Array.isArray(azureReports[0].shortlist) ? azureReports[0].shortlist.length : null,
    } : null,
    recentPdlCandidateCount: recentPdlCands.length,
    recentPdlCandidateFields: recentPdlCands.slice(0, 3).map(c => ({
      hasLinkedIn: typeof c.linkedinUrl === 'string' && /linkedin\.com\/in\//i.test(c.linkedinUrl),
      identityStatus: c.identityVerificationStatus,
      identitySource: c.identityVerificationSource,
      scoutDecision: c.scoutDecision,
    })),
  };
  console.log(JSON.stringify(report, null, 2));
})();
