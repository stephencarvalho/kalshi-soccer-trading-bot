function cleanParsedTeamName(value) {
  const text = String(value || '').trim();
  if (!text) return null;

  // Kalshi event titles sometimes prefix the matchup with competition context
  // like "EFL Cup Final: Arsenal vs Manchester City".
  const withoutPrefix = text.replace(/^.*:\s*/, '').trim();
  return withoutPrefix || text;
}

function parseTeamsFromEventTitle(title) {
  const text = String(title || '');
  const match =
    text.match(/^(.+?)\s+vs\.?\s+(.+?)(?:\?|$)/i) ||
    text.match(/^(.+?)\s+v\.?\s+(.+?)(?:\?|$)/i);
  if (!match) return { homeTeam: null, awayTeam: null };
  return {
    homeTeam: cleanParsedTeamName(match[1]),
    awayTeam: cleanParsedTeamName(match[2]),
  };
}

module.exports = {
  parseTeamsFromEventTitle,
};
