const SCORE_FORMULA_VERSION = 'score-v1';

function percentage(matches, count) {
  return count ? (matches / count) * 100 : null;
}

function rounded(value) {
  return value === null ? null : Math.round((value + Number.EPSILON) * 10) / 10;
}

function scoreMatchResults(results) {
  const required = results.filter((item) => item.priority === 'REQUIRED');
  const preferred = results.filter((item) => item.priority === 'PREFERRED');
  const count = (items, state) => items.filter((item) => item.matchState === state).length;
  const requiredMatches = count(required, 'MATCH');
  const preferredMatches = count(preferred, 'MATCH');
  const requiredScore = rounded(percentage(requiredMatches, required.length));
  const preferredScore = rounded(percentage(preferredMatches, preferred.length));
  let overallScore = 0;
  if (required.length && preferred.length) overallScore = (requiredScore * 0.70) + (preferredScore * 0.30);
  else if (required.length) overallScore = requiredScore;
  else if (preferred.length) overallScore = preferredScore;
  const score = {
    overallScore: rounded(overallScore),
    requiredScore,
    preferredScore,
    requiredCount: required.length,
    requiredMatches,
    requiredPartials: count(required, 'PARTIAL'),
    requiredMissing: count(required, 'MISSING'),
    preferredCount: preferred.length,
    preferredMatches,
    preferredPartials: count(preferred, 'PARTIAL'),
    preferredMissing: count(preferred, 'MISSING'),
    requiredWeight: 0.70,
    preferredWeight: 0.30,
    formulaVersion: SCORE_FORMULA_VERSION,
    formula: 'Required x 0.70 + Preferred x 0.30; when one group is empty, the available group is used; when both are empty, score is 0.',
  };
  return score;
}

module.exports = { SCORE_FORMULA_VERSION, scoreMatchResults };
