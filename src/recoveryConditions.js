const RECOVERY_CONDITION_LATE_TWO_GOAL_LEADER = 'late_two_goal_leader';
const RECOVERY_CONDITION_ANYTIME_LARGE_LEAD_SIGNAL = 'anytime_large_lead_signal';
const RECOVERY_CONDITION_CURRENT_LEAD_SIGNAL = 'current_lead_signal';
const RECOVERY_CONDITION_LATE_LEAD_SIGNAL = 'late_lead_signal';
const RECOVERY_CONDITION_LATE_TIE_SIGNAL = 'late_tie_signal';

const RECOVERY_CONDITION_OPTIONS = Object.freeze([
  RECOVERY_CONDITION_LATE_TWO_GOAL_LEADER,
  RECOVERY_CONDITION_ANYTIME_LARGE_LEAD_SIGNAL,
  RECOVERY_CONDITION_CURRENT_LEAD_SIGNAL,
  RECOVERY_CONDITION_LATE_LEAD_SIGNAL,
  RECOVERY_CONDITION_LATE_TIE_SIGNAL,
]);

const DEFAULT_RECOVERY_CONDITIONS = Object.freeze([
  RECOVERY_CONDITION_LATE_TWO_GOAL_LEADER,
  RECOVERY_CONDITION_ANYTIME_LARGE_LEAD_SIGNAL,
]);

const RECOVERY_CONDITION_ALIASES = Object.freeze({
  late_two_goal_leader: RECOVERY_CONDITION_LATE_TWO_GOAL_LEADER,
  leader_75_plus_2_goal: RECOVERY_CONDITION_LATE_TWO_GOAL_LEADER,
  leader_75_2: RECOVERY_CONDITION_LATE_TWO_GOAL_LEADER,
  recovery_75_plus_2_goal: RECOVERY_CONDITION_LATE_TWO_GOAL_LEADER,
  recovery_75_2: RECOVERY_CONDITION_LATE_TWO_GOAL_LEADER,
  anytime_large_lead: RECOVERY_CONDITION_ANYTIME_LARGE_LEAD_SIGNAL,
  anytime_large_lead_signal: RECOVERY_CONDITION_ANYTIME_LARGE_LEAD_SIGNAL,
  anytime_3_goal_leader: RECOVERY_CONDITION_ANYTIME_LARGE_LEAD_SIGNAL,
  anytime_3_plus_goal_leader: RECOVERY_CONDITION_ANYTIME_LARGE_LEAD_SIGNAL,
  three_goal_leader_anytime: RECOVERY_CONDITION_ANYTIME_LARGE_LEAD_SIGNAL,
  three_plus_goal_leader_anytime: RECOVERY_CONDITION_ANYTIME_LARGE_LEAD_SIGNAL,
  current_lead: RECOVERY_CONDITION_CURRENT_LEAD_SIGNAL,
  current_lead_signal: RECOVERY_CONDITION_CURRENT_LEAD_SIGNAL,
  late_lead: RECOVERY_CONDITION_LATE_LEAD_SIGNAL,
  late_lead_signal: RECOVERY_CONDITION_LATE_LEAD_SIGNAL,
  post_lead: RECOVERY_CONDITION_LATE_LEAD_SIGNAL,
  post_lead_signal: RECOVERY_CONDITION_LATE_LEAD_SIGNAL,
  late_tie: RECOVERY_CONDITION_LATE_TIE_SIGNAL,
  late_tie_signal: RECOVERY_CONDITION_LATE_TIE_SIGNAL,
  post_tie: RECOVERY_CONDITION_LATE_TIE_SIGNAL,
  post_tie_signal: RECOVERY_CONDITION_LATE_TIE_SIGNAL,
});

function normalizeRecoveryConditionToken(value) {
  const key = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return RECOVERY_CONDITION_ALIASES[key] || null;
}

function normalizeRecoveryConditionList(value) {
  const rawValues =
    value === undefined || value === null
      ? []
      : Array.isArray(value)
        ? value
        : String(value)
            .split(',')
            .map((item) => item.trim())
            .filter(Boolean);

  const normalized = [];
  for (const item of rawValues) {
    const token = normalizeRecoveryConditionToken(item);
    if (token && !normalized.includes(token)) normalized.push(token);
  }
  return normalized;
}

function normalizeRecoveryConditions(value, fallback = DEFAULT_RECOVERY_CONDITIONS) {
  const normalized = normalizeRecoveryConditionList(value);
  if (normalized.length) return normalized;
  return normalizeRecoveryConditionList(fallback);
}

function recoveryConditionMatchesCandidate(condition, candidate) {
  const game = candidate?.game || candidate || null;
  const signalRule = candidate?.signalRule || null;
  const anytimeLargeLeadMinGoalLead = Number(candidate?.runtime?.anytimeLargeLeadMinGoalLead);
  const largeLeadThreshold = Number.isFinite(anytimeLargeLeadMinGoalLead) && anytimeLargeLeadMinGoalLead > 0
    ? anytimeLargeLeadMinGoalLead
    : 3;

  switch (condition) {
    case RECOVERY_CONDITION_LATE_TWO_GOAL_LEADER:
      return Boolean(game?.leadingTeam) && Number(game?.minute || 0) >= 75 && Number(game?.goalDiff || 0) >= 2;
    case RECOVERY_CONDITION_ANYTIME_LARGE_LEAD_SIGNAL:
      return Boolean(game?.leadingTeam) && Number(game?.goalDiff || 0) >= largeLeadThreshold;
    case RECOVERY_CONDITION_CURRENT_LEAD_SIGNAL:
      return signalRule?.outcomeType === 'leader' && String(signalRule?.id || '').startsWith('CURRENT_LEAD_');
    case RECOVERY_CONDITION_LATE_LEAD_SIGNAL:
      return signalRule?.outcomeType === 'leader' && /^POST_\d+_LEAD_\d+$/.test(String(signalRule?.id || ''));
    case RECOVERY_CONDITION_LATE_TIE_SIGNAL:
      return signalRule?.outcomeType === 'tie';
    default:
      return false;
  }
}

function isRecoverySizingEligible(candidate, runtime) {
  const conditions = normalizeRecoveryConditions(runtime?.recoveryConditions);
  return conditions.some((condition) =>
    recoveryConditionMatchesCandidate(condition, {
      ...candidate,
      runtime,
    }),
  );
}

function describeRecoveryCondition(condition, runtime = {}) {
  const minGoalLead = Number(runtime?.minGoalLead);
  const anytimeLargeLead = Number(runtime?.anytimeLargeLeadMinGoalLead);
  const postStartMinute = Number(runtime?.post80StartMinute);
  const postLead = Number(runtime?.post80MinGoalLead);

  switch (condition) {
    case RECOVERY_CONDITION_LATE_TWO_GOAL_LEADER:
      return "75'+ leader with 2+ goal lead";
    case RECOVERY_CONDITION_ANYTIME_LARGE_LEAD_SIGNAL:
      return Number.isFinite(anytimeLargeLead)
        ? `anytime large-lead recovery (${anytimeLargeLead}+ goal lead now)`
        : 'anytime large-lead recovery';
    case RECOVERY_CONDITION_CURRENT_LEAD_SIGNAL:
      return Number.isFinite(minGoalLead)
        ? `current lead signal (${minGoalLead}+ goal lead now)`
        : 'current lead signal';
    case RECOVERY_CONDITION_LATE_LEAD_SIGNAL:
      return Number.isFinite(postStartMinute) && Number.isFinite(postLead)
        ? `${postStartMinute}'+ lead signal (${postLead}+ goal lead)`
        : 'late lead signal';
    case RECOVERY_CONDITION_LATE_TIE_SIGNAL:
      return Number.isFinite(postStartMinute)
        ? `${postStartMinute}'+ tie signal`
        : 'late tie signal';
    default:
      return String(condition || '');
  }
}

function describeRecoveryConditions(runtime = {}) {
  return normalizeRecoveryConditions(runtime?.recoveryConditions).map((condition) =>
    describeRecoveryCondition(condition, runtime),
  );
}

function formatRecoveryConditions(runtime = {}) {
  const descriptions = describeRecoveryConditions(runtime);
  if (!descriptions.length) return 'configured recovery setup';
  if (descriptions.length === 1) return descriptions[0];
  if (descriptions.length === 2) return `${descriptions[0]} or ${descriptions[1]}`;
  return `${descriptions.slice(0, -1).join(', ')}, or ${descriptions[descriptions.length - 1]}`;
}

module.exports = {
  RECOVERY_CONDITION_OPTIONS,
  DEFAULT_RECOVERY_CONDITIONS,
  normalizeRecoveryConditions,
  recoveryConditionMatchesCandidate,
  isRecoverySizingEligible,
  describeRecoveryConditions,
  formatRecoveryConditions,
};
