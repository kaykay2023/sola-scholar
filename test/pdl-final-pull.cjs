// Pull match/report state for the just-created Azure SE need to fill in the
// fields runPipeline would have returned (client fetch timed out).
// Run via: railway run --service hospitable-trust node test/pdl-final-pull.cjs

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

// Match needs created in last 30 minutes for Azure SE.
const cutoff = Date.now() - 30 * 60 * 1000;

(async () => {
  const [needs, matches, reports, cands] = await Promise.all([
    getJSON('/api/hiring-needs'),
    getJSON('/api/matches'),
    getJSON('/api/client-reports'),
    getJSON('/api/candidates'),
  ]);

  const recentAzureNeed = (needs.json || []).find(n => /azure security/i.test(n.title || '') && new Date(n.createdAt || 0).getTime() > cutoff);
  if (!recentAzureNeed) {
    console.log(JSON.stringify({ ok: false, reason: 'no recent Azure SE need found' }));
    process.exit(0);
  }
  const needId = recentAzureNeed.id;

  const allMatches = matches.json || [];
  const ourMatches = allMatches.filter(m => m.needId === needId);
  const visible = ourMatches.filter(m => m.status !== 'dropped');
  const dropped = ourMatches.filter(m => m.status === 'dropped');

  const ourReports = (reports.json || []).filter(r => r.needId === needId || (r.report && r.report.needId === needId));
  const report = ourReports[0];
  const reportShortlist = report ? (report.shortlist || (report.report && report.report.shortlist) || []) : [];

  const pdlCandidates = (cands.json || []).filter(c => c.source === 'PDL' && c.needId === needId);
  const pdlInVisible = visible.filter(m => {
    const c = (cands.json || []).find(x => x.id === m.candidateId);
    return c && c.source === 'PDL';
  });

  const out = {
    needId,
    sourcedRaw: recentAzureNeed.lastScoutStats && recentAzureNeed.lastScoutStats.sourcedRaw,
    apolloRaw: recentAzureNeed.lastScoutStats && recentAzureNeed.lastScoutStats.apolloRaw,
    pdlRaw: recentAzureNeed.lastScoutStats && recentAzureNeed.lastScoutStats.pdlRaw,
    firecrawlRaw: recentAzureNeed.lastScoutStats && recentAzureNeed.lastScoutStats.firecrawlRaw,
    githubRaw: recentAzureNeed.lastScoutStats && recentAzureNeed.lastScoutStats.githubRaw,
    acceptedCandidates: recentAzureNeed.lastScoutStats && recentAzureNeed.lastScoutStats.acceptedCandidates,
    reviewCandidates: recentAzureNeed.lastScoutStats && recentAzureNeed.lastScoutStats.needsScoutReview,
    rejectedCandidates: recentAzureNeed.lastScoutStats && recentAzureNeed.lastScoutStats.rejectedNonCandidates,
    acceptedBySource: recentAzureNeed.lastScoutStats && recentAzureNeed.lastScoutStats.acceptedBySource,
    reviewBySource: recentAzureNeed.lastScoutStats && recentAzureNeed.lastScoutStats.reviewBySource,
    rejectedBySource: recentAzureNeed.lastScoutStats && recentAzureNeed.lastScoutStats.rejectedBySource,
    matchTotal: ourMatches.length,
    visibleMatches: visible.length,
    droppedMatches: dropped.length,
    matchTierBreakdown: ourMatches.reduce((acc, m) => { acc[m.tier || 'unknown'] = (acc[m.tier || 'unknown'] || 0) + 1; return acc; }, {}),
    reportExists: !!report,
    reportShortlistCount: Array.isArray(reportShortlist) ? reportShortlist.length : 0,
    pdlCandidateCount: pdlCandidates.length,
    pdlCandidatesAllVerified: pdlCandidates.length > 0 && pdlCandidates.every(c => c.identityVerificationStatus === 'verified' && /linkedin\.com\/in\//i.test(c.linkedinUrl || '')),
    pdlInVisibleMatches: pdlInVisible.length,
    pdlSampleFields: pdlCandidates.slice(0, 3).map(c => ({
      hasLinkedIn: /linkedin\.com\/in\//i.test(c.linkedinUrl || ''),
      identityStatus: c.identityVerificationStatus,
      identitySource: c.identityVerificationSource,
      scoutDecision: c.scoutDecision,
      hasSkills: Array.isArray(c.skills) ? c.skills.length : 0,
    })),
  };
  console.log(JSON.stringify(out, null, 2));
})();
