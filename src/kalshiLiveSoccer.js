function parseMinute(text) {
  const s = String(text || '');
  const m = s.match(/(\d+)(?:\+(\d+))?\s*'?/);
  if (!m) return null;
  const base = Number(m[1]);
  const extra = m[2] ? Number(m[2]) : 0;
  if (!Number.isFinite(base) || !Number.isFinite(extra)) return null;
  return base + extra;
}

function parseTeams(title) {
  const t = String(title || '');
  const m = t.match(/^(.+?)\s+vs\s+(.+)$/i) || t.match(/^(.+?)\s+at\s+(.+)$/i);
  if (!m) return { homeTeam: null, awayTeam: null };
  return { homeTeam: m[1].trim(), awayTeam: m[2].trim() };
}

function milestoneIsLive(details) {
  const status = String(details?.status || '').toLowerCase();
  const widget = String(details?.widget_status || '').toLowerCase();
  const half = String(details?.half || '').toLowerCase();
  const notLiveStatus = ['closed', 'final', 'finished', 'ended', 'cancelled'];
  if (notLiveStatus.includes(status) || notLiveStatus.includes(widget) || half === 'ft') return false;
  if (status === 'open' || status === 'live' || widget === 'live' || widget === 'inprogress') return true;
  return Boolean(parseMinute(details?.time));
}

async function getLiveSoccerEventData(client, competitions) {
  const nowMs = Date.now();
  const minimumStartDate = new Date(nowMs - 6 * 3600 * 1000).toISOString();
  const milestones = [];

  for (const competition of competitions) {
    let cursor = '';
    let page = 0;
    do {
      const res = await client.request('GET', '/milestones', {
        params: {
          limit: 500,
          minimum_start_date: minimumStartDate,
          competition,
          cursor,
        },
      });
      milestones.push(...(res.milestones || []));
      cursor = res.cursor || '';
      page += 1;
    } while (cursor && page < 5);
  }

  const uniqueById = new Map();
  for (const m of milestones) uniqueById.set(m.id, m);
  const uniqueMilestones = Array.from(uniqueById.values());
  if (!uniqueMilestones.length) return new Map();

  const ids = uniqueMilestones.map((m) => m.id);
  const query = ids.map((id) => `milestone_ids=${encodeURIComponent(id)}`).join('&');
  const liveBatch = await client.request('GET', `/live_data/batch?${query}`);
  const liveDatas = liveBatch.live_datas || [];

  const byMilestoneId = new Map(liveDatas.map((x) => [x.milestone_id, x.details || {}]));
  const byEventTicker = new Map();

  for (const m of uniqueMilestones) {
    const details = byMilestoneId.get(m.id) || {};
    const isLive = milestoneIsLive(details);
    const minute = parseMinute(details.time || details.last_play?.description || '');
    const homeScore = Number.isFinite(Number(details.home_same_game_score)) ? Number(details.home_same_game_score) : null;
    const awayScore = Number.isFinite(Number(details.away_same_game_score)) ? Number(details.away_same_game_score) : null;
    const tickers = [...(m.primary_event_tickers || []), ...(m.related_event_tickers || [])].filter((t) => String(t).includes('GAME'));

    for (const ticker of tickers) {
      byEventTicker.set(ticker, {
        milestoneId: m.id,
        competition: m.details?.league || m.details?.competition || null,
        isLive,
        minute,
        homeScore,
        awayScore,
        half: details.half || null,
        status: details.status || null,
        statusText: details.status_text || null,
      });
    }
  }

  return byEventTicker;
}

function attachLiveDataToEvents(events, liveMap) {
  return events.map((event) => {
    const live = liveMap.get(event.event_ticker);
    if (!live) return event;

    const { homeTeam, awayTeam } = parseTeams(event.title);
    return {
      ...event,
      __live: {
        competition: live.competition || event.product_metadata?.competition || null,
        minute: live.minute,
        homeScore: live.homeScore,
        awayScore: live.awayScore,
        homeTeam,
        awayTeam,
        isLive: live.isLive,
        half: live.half,
        status: live.status,
        statusText: live.statusText,
      },
    };
  });
}

module.exports = {
  getLiveSoccerEventData,
  attachLiveDataToEvents,
};
