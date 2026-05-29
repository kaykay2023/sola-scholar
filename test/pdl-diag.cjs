// Diagnostic-only inspection of the last Azure SE run.
// Pulls top-10 visible matches, score/tier breakdown, PDL skills shape.
// Run via: railway run --service hospitable-trust node test/pdl-diag.cjs

const USER = process.env.INTERNAL_USER || 'sola';
const PASS = process.env.INTERNAL_PASSWORD || '';
if (!PASS) { console.log(JSON.stringify({ ok:false, reason:'INTERNAL_PASSWORD not in env' })); process.exit(1); }
const BASE = 'https://app.solascholars.com';
const auth = 'Basic ' + Buffer.from(`${USER}:${PASS}`).toString('base64');
async function getJSON(p) { const r = await fetch(`${BASE}${p}`, { headers:{ Authorization: auth } }); let j=null; try { j=await r.json(); } catch{}; return { status:r.status, json:j }; }

const cutoff = Date.now() - 24*60*60*1000;

(async () => {
  const [needs, matches, reports, cands] = await Promise.all([
    getJSON('/api/hiring-needs'),
    getJSON('/api/matches'),
    getJSON('/api/client-reports'),
    getJSON('/api/candidates'),
  ]);

  const azureNeeds = (needs.json||[])
    .filter(n => /azure security/i.test(n.title||'') && new Date(n.createdAt||0).getTime() > cutoff)
    .sort((a,b) => new Date(b.createdAt||0) - new Date(a.createdAt||0));
  const need = azureNeeds[0];
  if (!need) { console.log('no recent azure SE need'); process.exit(0); }
  const needId = need.id;

  // matches scoped to need (newest pipelineRunId pool)
  const allM = (matches.json||[]).filter(m => m.needId === needId);
  const runIds = [...new Set(allM.map(m => m.pipelineRunId).filter(Boolean))];
  const m = allM.sort((a,b)=> b.score - a.score);

  const candById = Object.fromEntries((cands.json||[]).map(c => [c.id, c]));

  // top 10
  const top10 = m.slice(0,10).map(x => {
    const c = candById[x.candidateId] || {};
    return {
      rank: x.rank,
      score: x.score,
      tier: x.tier,
      source: c.source || '',
      name: (c.name || '').slice(0,40),
      currentTitle: (c.currentTitle || '').slice(0,40),
      skillsCount: Array.isArray(c.skills) ? c.skills.length : 0,
      matchedSkills: x.matchedSkills || [],
      missingSkills: x.missingSkills || [],
      reviewReason: x.reviewReason || x.dropReason || '',
      reasoning: (x.reasoning || []).slice(0,3),
    };
  });

  // tier histogram across all matches
  const tierHist = m.reduce((a,x)=>{ a[x.tier||'?']=(a[x.tier||'?']||0)+1; return a; },{});

  // score histogram in buckets of 10
  const buckets = {};
  for (const x of m) { const b = Math.floor((x.score||0)/10)*10; buckets[`${b}-${b+9}`] = (buckets[`${b}-${b+9}`]||0)+1; }

  // PDL candidate skill shape — sample 3
  const pdlCands = (cands.json||[]).filter(c => c.source === 'PDL').slice(-25);  // most recent 25
  const pdlSample = pdlCands.slice(0,3).map(c => ({
    name: (c.name||'').slice(0,40),
    currentTitle: (c.currentTitle||'').slice(0,60),
    skillsCount: Array.isArray(c.skills) ? c.skills.length : 0,
    firstSkills: Array.isArray(c.skills) ? c.skills.slice(0,15) : [],
    hasLinkedIn: typeof c.linkedinUrl === 'string' && /linkedin\.com\/in\//i.test(c.linkedinUrl),
    identityStatus: c.identityVerificationStatus,
    needIdAttached: c.needId || null,
  }));

  // Lookup the client report for this need + measure candidates array (the actual shortlist field)
  const ourReport = (reports.json||[]).find(r => r.needId === needId);
  const reportCandidates = ourReport ? (ourReport.candidates || []) : [];

  // Also: count visible matches per source by joining match.candidateId → candidate.source
  const visibleBySource = {};
  for (const x of m) {
    const c = candById[x.candidateId];
    if (!c) continue;
    visibleBySource[c.source] = (visibleBySource[c.source]||0) + 1;
  }

  console.log(JSON.stringify({
    needId,
    pipelineRunIds: runIds,
    matchTotal: m.length,
    tierHistogram: tierHist,
    scoreBuckets: buckets,
    visibleMatchesBySource: visibleBySource,
    reportExists: !!ourReport,
    reportCandidatesCount: reportCandidates.length,
    reportCandidatesPreview: reportCandidates.slice(0,5).map(rc => ({ name: (rc.name||'').slice(0,40), score: rc.score, tier: rc.tier, matchedSkills: rc.matchedSkills, missingSkills: rc.missingSkills })),
    top10VisibleMatches: top10,
    pdlSkillShapeSample: pdlSample,
    needRequiredSkills: need.requiredSkills || [],
  }, null, 2));
})();
