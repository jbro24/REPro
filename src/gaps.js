const GAP_LOGIC_VERSION = 'gap-v1';

function gapForResult(result) {
  const subject = result.requirementText;
  const currentEvidence = result.evidence || [];
  const missingCapability = result.matchState === 'PARTIAL'
    ? `No VERIFIED evidence currently supports ${subject}.`
    : `No supporting evidence currently exists for ${subject}.`;
  const explanation = result.matchState === 'PARTIAL'
    ? `${subject} is partially supported. The current evidence describes learning or another context that does not establish a VERIFIED requirement match.`
    : `${subject} is missing because the available candidate records do not contain explicit supporting evidence for this requirement.`;
  const nextAction = result.requirementType === 'SKILL'
    ? `Create or link evidence that directly supports ${subject}.`
    : `Add evidence that directly addresses this ${result.requirementType.toLowerCase()} requirement.`;
  return {
    requirementId: result.requirementId,
    priority: result.priority,
    gapState: result.matchState,
    requirementText: subject,
    currentEvidence,
    missingCapability,
    explanation,
    nextAction,
  };
}

function analyzeGaps({ matchResults }) {
  return { logicVersion: GAP_LOGIC_VERSION, gaps: matchResults.filter((result) => result.matchState !== 'MATCH').map(gapForResult) };
}

module.exports = { GAP_LOGIC_VERSION, analyzeGaps };
