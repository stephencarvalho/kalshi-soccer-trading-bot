const axios = require("axios");

const SOCCER_FEED_URL =
	"https://api.elections.kalshi.com/v1/live_data/feed?include_events=true&include_markets=true&include_series=true&live_only=false&hydrate=structured_targets&page_size=20&milestone_types=soccer_tournament_multi_leg";

function parseMinute(text) {
	const s = String(text || "");
	const m = s.match(/(\d+)(?:\+(\d+))?\s*'?/);
	if (!m) return null;
	const base = Number(m[1]);
	const extra = m[2] ? Number(m[2]) : 0;
	if (!Number.isFinite(base) || !Number.isFinite(extra)) return null;
	return base + extra;
}

function normalizeText(value) {
	return String(value || "")
		.toLowerCase()
		.replace(/[^a-z0-9\s]/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}

function includesAny(value, needles) {
	return needles.some((needle) => value.includes(needle));
}

function isSoccerCompetitionName(name) {
	const v = normalizeText(name);
	if (!v) return false;

	const negative = [
		"basketball",
		"basquet",
		"wnba",
		"nba",
		"nfl",
		"baseball",
		"mlb",
		"hockey",
		"nhl",
		"cricket",
		"golf",
		"ufc",
		"mma",
		"boxing",
		"tennis",
		"esports",
		"video game",
		"college football",
		"pro football",
		"acb",
		"darts",
		"nascar",
		"ryder cup",
		"cup series",
		"extraliga",
	];
	if (includesAny(v, negative)) return false;

	const positive = [
		"soccer",
		"champions league",
		"europa league",
		"conference league",
		"world cup",
		"fa cup",
		"copa",
		"coppa",
		"cup",
		"premier league",
		"saudi pro league",
		"mls",
		"brasileiro",
		"campeonato brasileiro",
		"brasileirao",
		"italy serie a",
		"bundesliga",
		"la liga",
		"ligue 1",
		"eredivisie",
		"primeira",
		"super lig",
		"superliga",
		"hnl",
		"ekstraklasa",
		"liga portugal",
		"liga mx",
		"liga pro",
		"ligapro",
		"efl championship",
		"knvb",
		"usl championship",
		"swiss super league",
		"scottish premiership",
		"japan j1 league",
		"thai league 1",
		"nwsl",
		"concacaf",
		"conmebol",
		"afc champions",
		"uefa",
		"primera division",
	];
	return includesAny(v, positive);
}

function isAmbiguousSoccerCompetitionName(name) {
	const v = normalizeText(name);
	if (!v) return false;
	return includesAny(v, [
		"serie a",
		"superliga",
		"super lig",
		"liga pro",
		"ligapro",
		"primera division",
	]);
}

function isSoccerLiveDetails(details) {
	if (!details || typeof details !== "object") return false;

	const time = normalizeText(details.time || details.last_play?.description || "");
	if (time.match(/\b\d{1,3}(\s*\+\s*\d+)?\s*$/) || String(details.time || "").includes("'")) {
		return true;
	}

	const phase = normalizeText(
		details.half || details.status || details.status_text || "",
	);
	if (includesAny(phase, ["1h", "2h", "ht", "ft", "halftime", "full time"])) {
		return true;
	}

	const eventTypes = [
		...(details.home_significant_events || []),
		...(details.away_significant_events || []),
	]
		.map((event) => normalizeText(event?.event_type || event?.type || ""))
		.filter(Boolean);
	if (
		eventTypes.some((type) =>
			includesAny(type, [
				"red card",
				"yellow card",
				"second yellow",
				"own goal",
				"penalty",
				"substitution",
			]),
		)
	) {
		return true;
	}

	const redCardHints = [
		details.home_red_cards,
		details.home_red_card_count,
		details.home_cards_red,
		details.away_red_cards,
		details.away_red_card_count,
		details.away_cards_red,
	];
	return redCardHints.some((value) => Number.isFinite(Number(value)));
}

function eventLooksLikeSoccer(event, liveMap = null) {
	if (!event || typeof event !== "object") return false;
	const competition =
		event.product_metadata?.competition ||
		event.product_metadata?.league ||
		event.__live?.competition ||
		null;
	if (!isSoccerCompetitionName(competition)) return false;
	if (liveMap && liveMap.has(event.event_ticker)) return true;
	if (!isAmbiguousSoccerCompetitionName(competition)) return true;
	return isSoccerLiveDetails(event.__live || {});
}

function discoverSoccerCompetitionsFromEvents(events) {
	const competitions = new Set();
	for (const event of events || []) {
		const competition =
			event?.product_metadata?.competition ||
			event?.product_metadata?.league ||
			event?.__live?.competition ||
			null;
		if (!competition) continue;
		if (!isSoccerCompetitionName(competition)) continue;
		competitions.add(String(competition).trim());
	}
	return Array.from(competitions).sort((a, b) => a.localeCompare(b));
}

async function fetchSoccerCompetitionsFromFeed() {
	const response = await axios.get(SOCCER_FEED_URL, {
		timeout: 15000,
		headers: {
			"User-Agent": "Mozilla/5.0",
			Accept: "application/json",
		},
	});
	const competitions =
		response.data?.live_filters_by_sports?.Soccer?.competitions || [];
	return Array.from(
		new Set(
			competitions
				.map((competition) => String(competition || "").trim())
				.filter((competition) => isSoccerCompetitionName(competition))
				.filter(Boolean),
		),
	).sort((a, b) => a.localeCompare(b));
}

async function fetchLiveSoccerMilestonesFromFeed(competitions) {
	const hasAllLeagues = (competitions || []).some((x) =>
		["all", "*"].includes(String(x).trim().toLowerCase()),
	);
	const allowedCompetitions = new Set(
		(competitions || []).map((competition) => String(competition || "").trim()).filter(Boolean),
	);
	const milestones = [];
	const liveDatas = [];
	let cursor = "";
	let page = 0;

	do {
		const response = await axios.get("https://api.elections.kalshi.com/v1/live_data/feed", {
			timeout: 15000,
			headers: {
				"User-Agent": "Mozilla/5.0",
				Accept: "application/json",
			},
			params: {
				include_events: true,
				include_markets: true,
				include_series: true,
				live_only: true,
				hydrate: "structured_targets",
				page_size: 100,
				milestone_types: "soccer_tournament_multi_leg",
				cursor: cursor || undefined,
			},
		});

		for (const milestone of response.data?.live_milestones || []) {
			const competitionName =
				milestone?.competition || milestone?.details?.league || null;
			if (!isSoccerCompetitionName(competitionName)) continue;
			if (!hasAllLeagues && !allowedCompetitions.has(String(competitionName || "").trim())) continue;
			milestones.push(milestone);
		}
		liveDatas.push(...(response.data?.live_datas || []));
		cursor = response.data?.cursor || "";
		page += 1;
	} while (cursor && page < 10);

	return { milestones, liveDatas };
}

async function resolveSoccerCompetitionScope(
	client,
	events,
	competitions,
	logger,
) {
	const hasAllLeagues = (competitions || []).some((x) =>
		["all", "*"].includes(String(x).trim().toLowerCase()),
	);
	if (!hasAllLeagues) return competitions || [];

	const discovered = new Set(discoverSoccerCompetitionsFromEvents(events));
	try {
		const feedCompetitions = await fetchSoccerCompetitionsFromFeed();
		for (const competition of feedCompetitions) discovered.add(competition);
	} catch (error) {
		logger?.warn?.(
			{ err: error.message },
			"Failed to fetch soccer competitions from Kalshi live feed",
		);
	}
	return Array.from(discovered).sort((a, b) => a.localeCompare(b));
}

function parseNullableInt(value) {
	const n = Number(value);
	if (!Number.isFinite(n)) return null;
	return Math.trunc(n);
}

function countSignificantEvents(events, eventType) {
	if (!Array.isArray(events)) return null;
	let count = 0;
	let seenAny = false;
	for (const event of events) {
		if (!event || typeof event !== "object") continue;
		const type = String(event.event_type || event.type || "").toLowerCase();
		if (!type) continue;
		seenAny = true;
		if (type === eventType) count += 1;
	}
	return seenAny ? count : null;
}

function countDismissalEvents(events) {
	if (!Array.isArray(events)) return null;
	let count = 0;
	let seenAny = false;
	for (const event of events) {
		if (!event || typeof event !== "object") continue;
		const type = String(event.event_type || event.type || "").toLowerCase();
		if (!type) continue;
		seenAny = true;
		if (
			type === "red_card" ||
			type === "second_yellow_red_card" ||
			type === "yellow_red_card" ||
			type === "second_yellow"
		) {
			count += 1;
		}
	}
	return seenAny ? count : null;
}

function parseEventMinute(value) {
	return parseMinute(String(value || ""));
}

function computeLeadHistory(homeEvents, awayEvents) {
	const timeline = [];

	for (const event of homeEvents || []) {
		if (!event || String(event.event_type || "").toLowerCase() !== "score_change")
			continue;
		timeline.push({
			side: "home",
			minute: parseEventMinute(event.time),
		});
	}

	for (const event of awayEvents || []) {
		if (!event || String(event.event_type || "").toLowerCase() !== "score_change")
			continue;
		timeline.push({
			side: "away",
			minute: parseEventMinute(event.time),
		});
	}

	if (!timeline.length) {
		return {
			homeMaxLead: 0,
			awayMaxLead: 0,
		};
	}

	timeline.sort((a, b) => {
		const left = Number.isFinite(a.minute) ? a.minute : Number.MAX_SAFE_INTEGER;
		const right = Number.isFinite(b.minute) ? b.minute : Number.MAX_SAFE_INTEGER;
		if (left !== right) return left - right;
		if (a.side === b.side) return 0;
		return a.side === "home" ? -1 : 1;
	});

	let homeScore = 0;
	let awayScore = 0;
	let homeMaxLead = 0;
	let awayMaxLead = 0;

	for (const event of timeline) {
		if (event.side === "home") homeScore += 1;
		if (event.side === "away") awayScore += 1;
		homeMaxLead = Math.max(homeMaxLead, homeScore - awayScore);
		awayMaxLead = Math.max(awayMaxLead, awayScore - homeScore);
	}

	return {
		homeMaxLead,
		awayMaxLead,
	};
}

function parseTeams(title) {
	const t = String(title || "");
	const m = t.match(/^(.+?)\s+vs\s+(.+)$/i) || t.match(/^(.+?)\s+at\s+(.+)$/i);
	if (!m) return { homeTeam: null, awayTeam: null };
	return { homeTeam: m[1].trim(), awayTeam: m[2].trim() };
}

function milestoneIsLive(details) {
	const status = String(details?.status || "").toLowerCase();
	const widget = String(details?.widget_status || "").toLowerCase();
	const half = String(details?.half || "").toLowerCase();
	const notLiveStatus = ["closed", "final", "finished", "ended", "cancelled"];
	if (
		notLiveStatus.includes(status) ||
		notLiveStatus.includes(widget) ||
		half === "ft"
	)
		return false;
	if (
		status === "open" ||
		status === "live" ||
		widget === "live" ||
		widget === "inprogress"
	)
		return true;
	return Boolean(parseMinute(details?.time));
}

async function getLiveSoccerEventData(client, competitions) {
	try {
		const { milestones: feedMilestones, liveDatas: feedLiveDatas } =
			await fetchLiveSoccerMilestonesFromFeed(competitions);
		const byMilestoneId = new Map(
			(feedLiveDatas || []).map((x) => [x.milestone_id, x.details || {}]),
		);
		const byEventTicker = new Map();

		for (const milestone of feedMilestones || []) {
			const details = byMilestoneId.get(milestone.id) || {};
			const competitionName =
				milestone.competition || milestone.details?.league || null;
			if (!isSoccerCompetitionName(competitionName)) continue;
			if (
				isAmbiguousSoccerCompetitionName(competitionName) &&
				!isSoccerLiveDetails(details)
			) {
				continue;
			}

			const isLive = milestoneIsLive(details);
			const minute = parseMinute(
				details.time || details.last_play?.description || "",
			);
			const homeScore = Number.isFinite(Number(details.home_same_game_score))
				? Number(details.home_same_game_score)
				: null;
			const awayScore = Number.isFinite(Number(details.away_same_game_score))
				? Number(details.away_same_game_score)
				: null;
			const homeRedCards =
				parseNullableInt(details.home_red_cards) ??
				parseNullableInt(details.home_red_card_count) ??
				parseNullableInt(details.home_cards_red) ??
				countDismissalEvents(details.home_significant_events);
			const awayRedCards =
				parseNullableInt(details.away_red_cards) ??
				parseNullableInt(details.away_red_card_count) ??
				parseNullableInt(details.away_cards_red) ??
				countDismissalEvents(details.away_significant_events);
			const leadHistory = computeLeadHistory(
				details.home_significant_events,
				details.away_significant_events,
			);
			const tickers = [
				...(milestone.primary_event_tickers || []),
				...(milestone.related_event_tickers || []),
			].filter((t) => String(t).includes("GAME"));

			for (const ticker of tickers) {
				byEventTicker.set(ticker, {
					milestoneId: milestone.id,
					title: milestone.title || null,
					competition: competitionName,
					isLive,
					minute,
					homeScore,
					awayScore,
					homeRedCards,
					awayRedCards,
					homeMaxLead: leadHistory.homeMaxLead,
					awayMaxLead: leadHistory.awayMaxLead,
					half: details.half || null,
					status: details.status || null,
					statusText: details.status_text || null,
				});
			}
		}

		if (byEventTicker.size) {
			return byEventTicker;
		}
	} catch (_error) {
		// Fall back to the trade API milestone path below if the public live feed is unavailable.
	}

	const nowMs = Date.now();
	const minimumStartDate = new Date(nowMs - 6 * 3600 * 1000).toISOString();
	const milestones = [];

	if ((competitions || []).some((x) => ["all", "*"].includes(String(x).trim().toLowerCase()))) {
		let cursor = "";
		let page = 0;
		do {
			const res = await client.request("GET", "/milestones", {
				params: {
					limit: 500,
					minimum_start_date: minimumStartDate,
					cursor,
				},
			});
			milestones.push(...(res.milestones || []));
			cursor = res.cursor || "";
			page += 1;
		} while (cursor && page < 20);
	} else {
		for (const competition of competitions) {
			let cursor = "";
			let page = 0;
			do {
				const res = await client.request("GET", "/milestones", {
					params: {
						limit: 500,
						minimum_start_date: minimumStartDate,
						competition,
						cursor,
					},
				});
				milestones.push(...(res.milestones || []));
				cursor = res.cursor || "";
				page += 1;
			} while (cursor && page < 5);
		}
	}

	const uniqueById = new Map();
	for (const m of milestones) uniqueById.set(m.id, m);
	const uniqueMilestones = Array.from(uniqueById.values());
	if (!uniqueMilestones.length) return new Map();

	const ids = uniqueMilestones.map((m) => m.id);
	const liveDatas = [];
	const chunkSize = 100;
	for (let i = 0; i < ids.length; i += chunkSize) {
		const chunk = ids.slice(i, i + chunkSize);
		const query = chunk
			.map((id) => `milestone_ids=${encodeURIComponent(id)}`)
			.join("&");
		const liveBatch = await client.request("GET", `/live_data/batch?${query}`);
		liveDatas.push(...(liveBatch.live_datas || []));
	}

	const byMilestoneId = new Map(
		liveDatas.map((x) => [x.milestone_id, x.details || {}]),
	);
	const byEventTicker = new Map();

	for (const m of uniqueMilestones) {
		const details = byMilestoneId.get(m.id) || {};
		const competitionName = m.details?.league || m.details?.competition || null;
		if (!isSoccerCompetitionName(competitionName)) {
			continue;
		}
		if (isAmbiguousSoccerCompetitionName(competitionName) && !isSoccerLiveDetails(details)) {
			continue;
		}
		const isLive = milestoneIsLive(details);
		const minute = parseMinute(
			details.time || details.last_play?.description || "",
		);
		const homeScore = Number.isFinite(Number(details.home_same_game_score))
			? Number(details.home_same_game_score)
			: null;
		const awayScore = Number.isFinite(Number(details.away_same_game_score))
			? Number(details.away_same_game_score)
			: null;
			const homeRedCards =
				parseNullableInt(details.home_red_cards) ??
				parseNullableInt(details.home_red_card_count) ??
				parseNullableInt(details.home_cards_red) ??
				countDismissalEvents(details.home_significant_events);
			const awayRedCards =
				parseNullableInt(details.away_red_cards) ??
				parseNullableInt(details.away_red_card_count) ??
				parseNullableInt(details.away_cards_red) ??
				countDismissalEvents(details.away_significant_events);
		const leadHistory = computeLeadHistory(
			details.home_significant_events,
			details.away_significant_events,
		);
		const tickers = [
			...(m.primary_event_tickers || []),
			...(m.related_event_tickers || []),
		].filter((t) => String(t).includes("GAME"));

		for (const ticker of tickers) {
			byEventTicker.set(ticker, {
				milestoneId: m.id,
				title: m.title || null,
				competition: competitionName,
				isLive,
				minute,
				homeScore,
				awayScore,
				homeRedCards,
				awayRedCards,
				homeMaxLead: leadHistory.homeMaxLead,
				awayMaxLead: leadHistory.awayMaxLead,
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
				competition:
					live.competition || event.product_metadata?.competition || null,
				minute: live.minute,
				homeScore: live.homeScore,
				awayScore: live.awayScore,
				homeRedCards: live.homeRedCards,
				awayRedCards: live.awayRedCards,
				homeMaxLead: live.homeMaxLead,
				awayMaxLead: live.awayMaxLead,
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
	eventLooksLikeSoccer,
	isSoccerLiveDetails,
	isSoccerCompetitionName,
	discoverSoccerCompetitionsFromEvents,
	fetchSoccerCompetitionsFromFeed,
	resolveSoccerCompetitionScope,
};
