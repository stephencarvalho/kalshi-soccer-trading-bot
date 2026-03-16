import { CommonModule, CurrencyPipe, DatePipe, PercentPipe } from '@angular/common';
import { HttpClient } from '@angular/common/http';
import { Component, computed, effect, ElementRef, HostListener, inject, OnDestroy, signal, ViewChild } from '@angular/core';
import {
  CategoryScale,
  Chart,
  type Chart as ChartInstance,
  Filler,
  Legend,
  LineController,
  LineElement,
  LinearScale,
  PointElement,
  Tooltip,
  type ChartConfiguration,
} from 'chart.js';
import { buildApiUrl, getDashboardRuntimeConfig } from './runtime-config';

interface DashboardPayload {
  generatedAt: string;
  config: {
    dryRun: boolean;
    tradingEnabled: boolean;
    stakeUsd: number;
    maxYesPrice: number;
    minTriggerMinute: number;
    minGoalLead: number;
    retryUntilMinute: number;
    minVolume24hContracts: number;
    minLiquidityDollars: number;
    maxDailyLossUsd: number;
    recoveryModeEnabled?: boolean;
    recoveryStakeUsd?: number;
    recoveryMaxStakeUsd?: number;
    leagues: string[];
    timezone: string;
    runtimeOverridesPath?: string;
    runtimeOverrides?: Record<string, unknown>;
  };
  account: {
    balanceUsd: number | null;
    portfolioValueUsd: number | null;
    investedCapitalUsd: number | null;
    investedCapitalStartDate?: string | null;
    investedCapitalSource?: string | null;
    openPositionsCount: number;
    pnlTodayUsd: number;
    pnl14dUsd: number;
    openUnrealizedPnlUsd: number;
    openCostBasisUsd: number;
    openRoiPct: number | null;
  };
  bot: {
    lastCycleAt: string | null;
    tradedEventsCount: number;
    riskHaltedToday: boolean;
    status: 'STARTING' | 'UP_TRADING' | 'UP_DRY_RUN' | 'UP_BLOCKED_STOP_LOSS' | 'UP_DEGRADED' | 'DOWN';
    statusReason: string;
    lastError: string | null;
    currentStakeUsd?: number;
    recoveryLossStreak?: number;
    recoveryLossBalanceUsd?: number;
    validStatuses: string[];
  };
  metrics: {
    totalCycles: number;
    totalOrderSubmit: number;
    totalFilled: number;
    totalNotFilled: number;
    totalErrors: number;
    fillRate: number;
  };
  analytics: TradeAnalytics;
  recovery?: RecoveryAnalytics;
  leagueLeaderboard: LeagueLeaderboardRow[];
  monitoredGamesSummary: {
    total: number;
    eligibleNow: number;
    alreadyBet: number;
    noLiveData: number;
  };
  monitoredGames: MonitoredGameRecord[];
  recentLogs: LogRecord[];
  recentCycleLogs: LogRecord[];
  openTrades: TradeRecord[];
  closedTrades: ClosedTradeRecord[];
}

interface LogRecord {
  ts: string;
  action: string;
  [key: string]: unknown;
}

interface TradeRecord {
  ticker: string;
  event_ticker?: string;
  event_title?: string | null;
  current_score?: string | null;
  selection_label?: string | null;
  market_title?: string | null;
  market_status?: string | null;
  position_fp?: string;
  side?: string;
  quantity?: number;
  cost_basis_usd?: number;
  amount_bet_usd?: number;
  current_contract_cost_usd?: number | null;
  mark_price?: number | null;
  mark_value_usd?: number | null;
  total_return_usd?: number | null;
  unrealized_pnl_usd?: number | null;
  unrealized_roi_pct?: number | null;
  realized_pnl_dollars?: number;
  fees_paid_dollars?: number;
  last_updated_ts?: string | null;
  placed_context?: {
    triggerRule?: string;
    placedMinute?: number;
    placedScore?: string;
    placedCards?: string | null;
    placedLeaderVsTrailingCards?: string | null;
    stakeUsdTarget?: number | null;
    targetProfitUsd?: number | null;
    recoveryQueueId?: string | null;
    recoveryRemainingUsd?: number | null;
    recoverySourceLossUsd?: number | null;
    recoverySourceEventTitle?: string | null;
    sizingMode?: string | null;
    leadingTeam?: string | null;
    leadingTeamMaxLead?: number | null;
    eventTitle?: string | null;
    selectedOutcome?: string | null;
    markedAt?: string;
    yesPrice?: number | null;
    fillCount?: number | null;
  } | null;
}

interface ClosedTradeRecord {
  ticker: string;
  event_ticker?: string;
  market_result: string;
  yes_count_fp?: string;
  no_count_fp?: string;
  settled_time: string;
  pnl_usd: number;
  total_cost_usd?: number;
  amount_bet_usd?: number;
  total_return_usd?: number;
  roi_pct?: number | null;
  wins_to_recover_at_avg_win?: number | null;
  placed_context?: {
    triggerRule?: string;
    placedMinute?: number;
    placedScore?: string;
    placedCards?: string | null;
    placedLeaderVsTrailingCards?: string | null;
    stakeUsdTarget?: number | null;
    targetProfitUsd?: number | null;
    recoveryQueueId?: string | null;
    recoveryRemainingUsd?: number | null;
    recoverySourceLossUsd?: number | null;
    recoverySourceEventTitle?: string | null;
    sizingMode?: string | null;
    leadingTeam?: string | null;
    leadingTeamMaxLead?: number | null;
    eventTitle?: string | null;
    selectedOutcome?: string | null;
    markedAt?: string;
    yesPrice?: number | null;
    fillCount?: number | null;
  } | null;
}

interface TradeAnalytics {
  settledTrades: number;
  winners: number;
  losers: number;
  pushes: number;
  winRate: number | null;
  lossRate: number | null;
  avgWinnerRoiPct: number | null;
  avgLoserRoiPct: number | null;
  avgRoiPct: number | null;
  avgWinUsd: number | null;
  avgWinRoiUsd: number | null;
  avgLossAbsUsd: number | null;
  betsNeededToRecoverAvgLoss: number | null;
  winsRequiredToRecoverSingleLoss: number | null;
  winsRequiredToBreakeven: number;
  breakevenWinRate: number | null;
  payoffRatio: number | null;
  profitFactor: number | null;
  expectancyPerTradeUsd: number | null;
  maxDrawdownUsd: number | null;
  avgTotalCostUsd: number | null;
  longestWinStreak: number;
  longestLossStreak: number;
}

interface RecoveryTradeLink {
  tradeKey: string;
  eventTitle: string;
  competition: string;
  settledTime: string;
  pnlUsd: number;
  amountBetUsd: number | null;
  stakeUsdTarget: number | null;
  yesPrice: number | null;
  contracts: number | null;
  targetedRemainingUsdBefore?: number;
  allocatedRecoveryUsd?: number;
}

interface RecoveryQueueRow {
  queueId: string;
  sourceTradeKey: string;
  sourceTicker: string;
  sourceEventTicker: string | null;
  sourceEventTitle: string;
  competition: string;
  lossSettledTime: string;
  lossUsd: number;
  recoveredUsd: number;
  remainingTargetUsd: number;
  status: string;
  resolvedAt: string | null;
  recoveryBet: RecoveryTradeLink | null;
  recoveryBetResultUsd: number | null;
  resolutionTrade: RecoveryTradeLink | null;
}

interface RecoveryAnalytics {
  enabled: boolean;
  strategy?: string;
  baseStakeUsd: number;
  currentLossStreak: number;
  recoveryLossBalanceUsd: number;
  nextTargetProfitUsd: number;
  unresolvedLossCount: number;
  queue: RecoveryQueueRow[];
}

interface LeagueLeaderboardRow {
  league: string;
  trades: number;
  wins: number;
  losses: number;
  pushes: number;
  winRate: number | null;
  totalPnlUsd: number;
  avgRoiPct: number | null;
}

interface MonitoredGameRecord {
  eventTicker: string;
  title: string;
  competition: string;
  minute: number | null;
  score: string;
  homeTeam?: string | null;
  awayTeam?: string | null;
  homeYesPrice?: number | null;
  awayYesPrice?: number | null;
  redCards: string | null;
  leadingVsTrailingRedCards: string | null;
  leadingTeam: string;
  goalDiff: number | null;
  status: 'ELIGIBLE_NOW' | 'ELIGIBLE_NO_CAPACITY' | 'ALREADY_BET' | 'WATCHING' | 'FILTERED' | 'NO_LIVE_DATA';
  reason: string;
}

type ThemeMode = 'light' | 'dark';
type ChartRange = 'LIVE' | '1H' | '3H' | '6H' | '12H' | '1D' | '1W' | '1M' | '3M' | '6M' | 'YTD' | '1Y' | '3Y' | '5Y' | 'ALL';
type LogViewMode = 'important' | 'verbose';
type LogTimeRange = 'TODAY' | '24H' | '7D' | 'ALL';
type SortDirection = 'asc' | 'desc';
type TableId = 'monitoredGames' | 'openTrades' | 'recoveryQueue' | 'leagueLeaderboard' | 'closedTrades';

interface TableSortState {
  key: string;
  direction: SortDirection;
}

const DEFAULT_TABLE_SORT: Record<TableId, TableSortState> = {
  monitoredGames: { key: 'minute', direction: 'desc' },
  openTrades: { key: 'lastUpdated', direction: 'desc' },
  recoveryQueue: { key: 'remainingTargetUsd', direction: 'desc' },
  leagueLeaderboard: { key: 'avgRoiPct', direction: 'desc' },
  closedTrades: { key: 'settledTime', direction: 'desc' },
};

interface PnlPoint {
  ts: number;
  pnl: number;
}

interface MetricCard {
  label: string;
  value: number | null;
  format: 'usd' | 'pct' | 'num';
  secondaryPct?: number | null;
}

interface HeaderMetric {
  label: string;
  value: string;
  tone?: 'pos' | 'neg' | '';
}

interface MetricSection {
  title: string;
  subtitle: string;
  columns?: 'three' | 'four';
  cards: MetricCard[];
}

interface LogField {
  key: string;
  label: string;
  value: string;
}

Chart.register(LineController, LineElement, PointElement, LinearScale, CategoryScale, Tooltip, Legend, Filler);

@Component({
  selector: 'app-root',
  imports: [CommonModule, DatePipe, CurrencyPipe, PercentPipe],
  templateUrl: './app.html',
  styleUrl: './app.scss',
})
export class App implements OnDestroy {
  private readonly http = inject(HttpClient);
  @ViewChild('pnlChart')
  set chartCanvasRef(value: ElementRef<HTMLCanvasElement> | undefined) {
    this.chartCanvas = value;
    if (value) {
      queueMicrotask(() => this.renderChart());
    }
  }
  private chartCanvas?: ElementRef<HTMLCanvasElement>;
  @ViewChild('chartWrap') private chartWrap?: ElementRef<HTMLElement>;
  private chartInstance: Chart<'line'> | null = null;
  private chartPoints: PnlPoint[] = [];
  private readonly chartSelectionPlugin = {
    id: 'selectionGuides',
    afterDatasetsDraw: (chart: ChartInstance<'line'>) => {
      const ctx = chart.ctx;
      const top = chart.chartArea.top;
      const bottom = chart.chartArea.bottom;
      const left = chart.chartArea.left;
      const right = chart.chartArea.right;
      const yScale = chart.scales['y'];

      if (yScale && Number.isFinite(yScale.min) && Number.isFinite(yScale.max) && yScale.min <= 0 && yScale.max >= 0) {
        const zeroY = yScale.getPixelForValue(0);
        ctx.save();
        ctx.strokeStyle = this.theme() === 'dark' ? 'rgba(154, 165, 177, 0.4)' : 'rgba(111, 114, 119, 0.4)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(left, zeroY);
        ctx.lineTo(right, zeroY);
        ctx.stroke();
        ctx.restore();
      }

      const selected = [...this.selectedChartPoints()].sort((a, b) => a.ts - b.ts);
      const hovered = selected.length ? null : this.hoveredPoint();
      const targets = selected.length ? selected : hovered ? [hovered] : [];
      if (!targets.length) return;
      const datasetMeta = chart.getDatasetMeta(0);

      ctx.save();
      ctx.strokeStyle = this.theme() === 'dark' ? 'rgba(154, 165, 177, 0.55)' : 'rgba(111, 114, 119, 0.55)';
      ctx.lineWidth = 1;

      const xs = [];
      for (const point of targets) {
        const idx = this.chartPoints.findIndex((candidate) => candidate.ts === point.ts && candidate.pnl === point.pnl);
        const element = idx >= 0 ? datasetMeta.data[idx] : null;
        const x = element?.x;
        if (typeof x !== 'number') continue;
        xs.push(x);
        ctx.beginPath();
        ctx.moveTo(x, top);
        ctx.lineTo(x, bottom);
        ctx.stroke();
      }

      const label = selected.length >= 2
        ? `${this.formatReadoutTs(selected[0].ts)} - ${this.formatReadoutTs(selected[1].ts)}`
        : this.formatReadoutTs((targets[0] || hovered).ts);

      if (label && xs.length) {
        const centerX = selected.length >= 2
          ? (Math.min(...xs) + Math.max(...xs)) / 2
          : xs[0];
        const clampedX = Math.min(right - 8, Math.max(left + 8, centerX));
        const labelY = selected.length >= 2 ? top + 8 : Math.max(8, top - 18);
        ctx.fillStyle = this.theme() === 'dark' ? '#c7d0d9' : '#5b6470';
        ctx.font = '600 12px Space Grotesk, Manrope, sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'top';
        ctx.fillText(label, clampedX, labelY);
      }

      ctx.restore();
    },
  };
  private readonly chartViewReady = signal(false);
  private refreshTimer: ReturnType<typeof setInterval> | null = null;

  readonly loading = signal(true);
  readonly error = signal<string | null>(null);
  readonly data = signal<DashboardPayload | null>(null);
  readonly now = signal(new Date());
  readonly theme = signal<ThemeMode>(this.loadTheme());
  readonly chartRange = signal<ChartRange>('ALL');
  readonly logViewMode = signal<LogViewMode>('important');
  readonly logTimeRange = signal<LogTimeRange>('TODAY');
  readonly tableSort = signal<Record<TableId, TableSortState>>({ ...DEFAULT_TABLE_SORT });
  readonly chartRanges: ChartRange[] = ['LIVE', '1H', '3H', '6H', '12H', '1D', '1W', '1M', '3M', '6M', 'YTD', '1Y', '3Y', '5Y', 'ALL'];
  readonly logTimeRanges: LogTimeRange[] = ['TODAY', '24H', '7D', 'ALL'];
  readonly hoveredPoint = signal<PnlPoint | null>(null);
  readonly selectedChartPoints = signal<PnlPoint[]>([]);
  readonly visibleLogs = computed(() => {
    const d = this.data();
    if (!d) return [] as LogRecord[];
    const selected = this.logViewMode() === 'important' ? d.recentLogs : d.recentCycleLogs;
    const nowTs = this.now().getTime();
    const range = this.logTimeRange();
    let fromTs = Number.NEGATIVE_INFINITY;

    if (range === 'TODAY') {
      const start = new Date();
      start.setHours(0, 0, 0, 0);
      fromTs = start.getTime();
    } else if (range === '24H') {
      fromTs = nowTs - 24 * 60 * 60 * 1000;
    } else if (range === '7D') {
      fromTs = nowTs - 7 * 24 * 60 * 60 * 1000;
    }

    return selected.filter((item) => {
      const ts = new Date(String(item.ts || '')).getTime();
      return Number.isFinite(ts) ? ts >= fromTs : false;
    });
  });
  readonly sortedMonitoredGames = computed<MonitoredGameRecord[]>(() => {
    const d = this.data();
    if (!d) return [];
    return this.sortRows(d.monitoredGames || [], this.tableSort().monitoredGames, {
      minute: (row) => row.minute,
      competition: (row) => row.competition,
      title: (row) => row.title,
      score: (row) => row.score,
      homeYesPrice: (row) => row.homeYesPrice,
      awayYesPrice: (row) => row.awayYesPrice,
      redCards: (row) => row.redCards,
      leadingTeam: (row) => row.leadingTeam,
      goalDiff: (row) => row.goalDiff,
      status: (row) => row.status,
      reason: (row) => row.reason,
    });
  });
  readonly sortedOpenTrades = computed<TradeRecord[]>(() => {
    const d = this.data();
    if (!d) return [];
    return this.sortRows(d.openTrades || [], this.tableSort().openTrades, {
      ticker: (row) => row.ticker,
      eventTitle: (row) => row.event_title || row.event_ticker,
      currentScore: (row) => row.current_score,
      selectionLabel: (row) => row.selection_label || row.market_title,
      marketStatus: (row) => row.market_status,
      quantity: (row) => row.quantity,
      amountBetUsd: (row) => row.amount_bet_usd,
      entryPx: (row) => row.placed_context?.yesPrice,
      totalReturnUsd: (row) => row.total_return_usd,
      costBasisUsd: (row) => row.cost_basis_usd,
      currentContractCostUsd: (row) => row.current_contract_cost_usd,
      markPrice: (row) => row.mark_price,
      unrealizedPnlUsd: (row) => row.unrealized_pnl_usd,
      unrealizedRoiPct: (row) => row.unrealized_roi_pct,
      condition: (row) => row.placed_context?.triggerRule,
      cards: (row) => row.placed_context?.placedCards,
      lastUpdated: (row) => this.toTimestamp(row.last_updated_ts),
    });
  });
  readonly sortedRecoveryQueue = computed<RecoveryQueueRow[]>(() => {
    const d = this.data();
    if (!d) return [];
    return this.sortRows(d.recovery?.queue || [], this.tableSort().recoveryQueue, {
      queueId: (row) => row.queueId,
      sourceEventTitle: (row) => row.sourceEventTitle,
      competition: (row) => row.competition,
      lossUsd: (row) => row.lossUsd,
      recoveredUsd: (row) => row.recoveredUsd,
      remainingTargetUsd: (row) => row.remainingTargetUsd,
      recoveryBet: (row) => row.recoveryBet?.eventTitle,
      stakeUsdTarget: (row) => row.recoveryBet?.stakeUsdTarget,
      yesPrice: (row) => row.recoveryBet?.yesPrice,
      recoveryBetResultUsd: (row) => row.recoveryBetResultUsd,
      status: (row) => row.status,
    });
  });
  readonly sortedLeagueLeaderboard = computed<LeagueLeaderboardRow[]>(() => {
    const d = this.data();
    if (!d) return [];
    return this.sortRows(d.leagueLeaderboard || [], this.tableSort().leagueLeaderboard, {
      league: (row) => row.league,
      trades: (row) => row.trades,
      wins: (row) => row.wins,
      losses: (row) => row.losses,
      winRate: (row) => row.winRate,
      avgRoiPct: (row) => row.avgRoiPct,
      totalPnlUsd: (row) => row.totalPnlUsd,
    });
  });
  readonly sortedClosedTrades = computed<ClosedTradeRecord[]>(() => {
    const d = this.data();
    if (!d) return [];
    return this.sortRows(d.closedTrades || [], this.tableSort().closedTrades, {
      settledTime: (row) => this.toTimestamp(row.settled_time),
      ticker: (row) => row.ticker,
      eventTitle: (row) => row.placed_context?.eventTitle || row.event_ticker,
      marketResult: (row) => row.market_result,
      amountBetUsd: (row) => row.amount_bet_usd,
      totalReturnUsd: (row) => row.total_return_usd,
      pnlUsd: (row) => row.pnl_usd,
      roiPct: (row) => row.roi_pct,
      winsToRecover: (row) => row.wins_to_recover_at_avg_win,
      placedCondition: (row) => row.placed_context?.triggerRule,
      cards: (row) => row.placed_context?.placedCards,
    });
  });

  readonly liveDeskMetrics = computed<MetricCard[]>(() => {
    const d = this.data();
    if (!d) return [];
    return [
      { label: 'Live Games', value: d.monitoredGamesSummary.total, format: 'num' },
      { label: 'Eligible Now', value: d.monitoredGamesSummary.eligibleNow, format: 'num' },
      { label: 'Already Bet', value: d.monitoredGamesSummary.alreadyBet, format: 'num' },
      { label: 'Open Positions', value: d.account.openPositionsCount, format: 'num' },
      { label: 'Orders Filled', value: d.metrics.totalFilled, format: 'num' },
      { label: 'Fill Rate', value: d.metrics.fillRate, format: 'pct' },
    ];
  });
  readonly netAccountValue = computed(() => {
    const d = this.data();
    if (!d) return null;
    if (d.account.balanceUsd === null && d.account.portfolioValueUsd === null) return null;
    return Number(((d.account.balanceUsd ?? 0) + (d.account.portfolioValueUsd ?? 0)).toFixed(2));
  });
  readonly headerMetrics = computed<HeaderMetric[]>(() => {
    const d = this.data();
    if (!d) return [];
    const allTimePnl = this.allTimePnlStats();

    const netAccountValue = this.netAccountValue();
    const totalInvested =
      d.account.investedCapitalUsd === null || d.account.investedCapitalUsd === undefined
        ? null
        : Number(d.account.investedCapitalUsd.toFixed(2));
    const allTimePnlPct = totalInvested && totalInvested > 0 ? (allTimePnl.value / totalInvested) : null;

    return [
      {
        label: 'Net Account Value',
        value: netAccountValue === null ? '-' : `$${netAccountValue.toFixed(2)}`,
        tone: this.numberTone(netAccountValue),
      },
      {
        label: 'Available Balance',
        value: d.account.balanceUsd === null ? '-' : `$${Number(d.account.balanceUsd).toFixed(2)}`,
        tone: this.numberTone(d.account.balanceUsd),
      },
      {
        label: 'All-Time PnL',
        value:
          allTimePnlPct === null
            ? `${allTimePnl.value >= 0 ? '+' : ''}$${allTimePnl.value.toFixed(2)}`
            : `${allTimePnl.value >= 0 ? '+' : ''}$${allTimePnl.value.toFixed(2)} (${allTimePnlPct >= 0 ? '+' : ''}${(allTimePnlPct * 100).toFixed(2)}%)`,
        tone: this.numberTone(allTimePnl.value),
      },
      {
        label: 'Open Position Value',
        value: d.account.portfolioValueUsd === null ? '-' : `$${Number(d.account.portfolioValueUsd).toFixed(2)}`,
        tone: this.numberTone(d.account.portfolioValueUsd),
      },
      {
        label: 'Total Amount Invested',
        value: totalInvested === null ? '-' : `$${totalInvested.toFixed(2)}`,
        tone: this.numberTone(totalInvested),
      },
    ];
  });

  readonly botPerformanceMetrics = computed<MetricCard[]>(() => {
    const d = this.data();
    if (!d) return [];
    const investedCapital = this.investedCapital();
    const pctOfInvested = (value: number | null) =>
      investedCapital && investedCapital > 0 && value !== null && value !== undefined
        ? value / investedCapital
        : null;
    return [
      { label: 'Available Balance', value: d.account.balanceUsd, format: 'usd' },
      { label: 'Open Position Value', value: d.account.portfolioValueUsd, format: 'usd' },
      {
        label: 'Net Account Value',
        value:
          d.account.balanceUsd === null && d.account.portfolioValueUsd === null
            ? null
            : Number(((d.account.balanceUsd ?? 0) + (d.account.portfolioValueUsd ?? 0)).toFixed(2)),
        format: 'usd',
      },
      { label: 'Today PnL', value: d.account.pnlTodayUsd, format: 'usd', secondaryPct: pctOfInvested(d.account.pnlTodayUsd) },
      { label: 'Realized PnL', value: d.account.pnl14dUsd, format: 'usd', secondaryPct: pctOfInvested(d.account.pnl14dUsd) },
      {
        label: 'Open ROI PnL',
        value: d.account.openUnrealizedPnlUsd,
        format: 'usd',
        secondaryPct: pctOfInvested(d.account.openUnrealizedPnlUsd),
      },
      { label: 'Open ROI %', value: d.account.openRoiPct, format: 'pct' },
    ];
  });

  readonly tradePerformanceMetrics = computed<MetricCard[]>(() => {
    const d = this.data();
    if (!d) return [];
    return [
      { label: 'Win Rate', value: d.analytics.winRate, format: 'pct' },
      { label: 'Avg Winner ROI', value: d.analytics.avgWinnerRoiPct, format: 'pct' },
      { label: 'Avg $ ROI / Win', value: d.analytics.avgWinRoiUsd, format: 'usd' },
      { label: 'Avg PnL Per Trade', value: d.analytics.expectancyPerTradeUsd, format: 'usd' },
      { label: 'Avg Loss (Abs)', value: d.analytics.avgLossAbsUsd, format: 'usd' },
      { label: 'Breakeven Win Rate', value: d.analytics.breakevenWinRate, format: 'pct' },
      { label: 'Max Drawdown', value: d.analytics.maxDrawdownUsd, format: 'usd' },
      { label: 'Longest Win Streak', value: d.analytics.longestWinStreak, format: 'num' },
      { label: 'Longest Loss Streak', value: d.analytics.longestLossStreak, format: 'num' },
    ];
  });

  readonly riskMetrics = computed<MetricCard[]>(() => {
    const d = this.data();
    if (!d) return [];
    const netAccountValue =
      (d.account.balanceUsd ?? 0) +
      (d.account.portfolioValueUsd ?? 0);
    const edgeGap =
      d.analytics.winRate !== null && d.analytics.breakevenWinRate !== null
        ? d.analytics.winRate - d.analytics.breakevenWinRate
        : null;
    const avgLossToWin =
      d.analytics.avgLossAbsUsd && d.analytics.avgWinUsd
        ? d.analytics.avgLossAbsUsd / d.analytics.avgWinUsd
        : null;
    const avgBetPct =
      netAccountValue > 0 && d.analytics.avgTotalCostUsd !== null
        ? d.analytics.avgTotalCostUsd / netAccountValue
        : null;
    const maxDrawdownPct =
      netAccountValue > 0 && d.analytics.maxDrawdownUsd !== null
        ? d.analytics.maxDrawdownUsd / netAccountValue
        : null;
    const stopLossPct =
      netAccountValue > 0 && d.config.maxDailyLossUsd !== null && d.config.maxDailyLossUsd !== undefined
        ? d.config.maxDailyLossUsd / netAccountValue
        : null;
    const recoveryQueuePct =
      netAccountValue > 0 && d.recovery?.recoveryLossBalanceUsd !== undefined
        ? d.recovery.recoveryLossBalanceUsd / netAccountValue
        : null;
    const lossesToStop =
      d.analytics.avgLossAbsUsd && d.analytics.avgLossAbsUsd > 0
        ? Math.floor(d.config.maxDailyLossUsd / d.analytics.avgLossAbsUsd)
        : null;
    const lossesToBankrupt =
      d.analytics.avgLossAbsUsd && d.analytics.avgLossAbsUsd > 0 && (d.account.balanceUsd ?? 0) > 0
        ? Math.floor((d.account.balanceUsd ?? 0) / d.analytics.avgLossAbsUsd)
        : null;

    return [
      { label: 'Edge Gap', value: edgeGap, format: 'pct' },
      { label: 'Loss / Win Ratio', value: avgLossToWin, format: 'num' },
      { label: 'Avg Bet % Bankroll', value: avgBetPct, format: 'pct' },
      { label: 'Max Drawdown %', value: maxDrawdownPct, format: 'pct' },
      { label: 'Stop-Loss % Bankroll', value: stopLossPct, format: 'pct' },
      { label: 'Recovery Queue %', value: recoveryQueuePct, format: 'pct' },
      { label: 'Avg Losses To Stop', value: lossesToStop, format: 'num' },
      { label: 'Avg Losses To Bankrupt', value: lossesToBankrupt, format: 'num' },
    ];
  });

  readonly riskStatus = computed(() => {
    const d = this.data();
    if (!d) {
      return {
        edge: 'Unknown',
        ruinRisk: 'Unknown',
        note: 'No dashboard data loaded',
      };
    }
    const expectancy = d.analytics.expectancyPerTradeUsd;
    const edgeGap =
      d.analytics.winRate !== null && d.analytics.breakevenWinRate !== null
        ? d.analytics.winRate - d.analytics.breakevenWinRate
        : null;
    const queueBurden = d.recovery?.recoveryLossBalanceUsd ?? 0;
    const balance = d.account.balanceUsd ?? 0;

    if ((expectancy ?? 0) < 0 || (edgeGap ?? 0) < 0) {
      return {
        edge: 'Negative',
        ruinRisk: 'High',
        note: 'Current win rate is below breakeven for the current payoff profile.',
      };
    }

    if (queueBurden > balance * 0.15) {
      return {
        edge: 'Thin',
        ruinRisk: 'Elevated',
        note: 'Recovery burden is large relative to available balance.',
      };
    }

    return {
      edge: 'Positive',
      ruinRisk: 'Controlled',
      note: 'Sustainability still depends on keeping stake size small relative to bankroll.',
    };
  });

  readonly recoveryMetrics = computed<MetricCard[]>(() => {
    const d = this.data();
    if (!d) return [];
    return [
      { label: 'Next Recovery Target', value: d.recovery?.nextTargetProfitUsd ?? 0, format: 'usd' },
      { label: 'Unresolved Losses', value: d.recovery?.unresolvedLossCount ?? 0, format: 'num' },
      { label: 'Loss Streak', value: d.recovery?.currentLossStreak ?? d.bot.recoveryLossStreak ?? 0, format: 'num' },
      { label: 'Recovery Loss $', value: d.recovery?.recoveryLossBalanceUsd ?? d.bot.recoveryLossBalanceUsd ?? 0, format: 'usd' },
      { label: 'Wins / Single Loss', value: d.analytics.winsRequiredToRecoverSingleLoss, format: 'num' },
      { label: 'Wins To Breakeven', value: d.analytics.winsRequiredToBreakeven, format: 'num' },
      { label: 'Base Stake', value: d.recovery?.baseStakeUsd ?? d.config.stakeUsd ?? null, format: 'usd' },
    ];
  });

  readonly pnlSeries = computed(() => {
    const d = this.data();
    if (!d) return [] as PnlPoint[];

    const sorted = [...(d.closedTrades || [])].sort(
      (a, b) => new Date(a.settled_time).getTime() - new Date(b.settled_time).getTime(),
    );

    const points: PnlPoint[] = [];
    let cumulative = 0;
    const firstSettledTs = sorted.length ? new Date(sorted[0].settled_time).getTime() : null;

    if (firstSettledTs !== null && Number.isFinite(firstSettledTs)) {
      points.push({
        ts: firstSettledTs - 1,
        pnl: 0,
      });
    }

    for (const t of sorted) {
      cumulative += Number(t.pnl_usd || 0);
      points.push({
        ts: new Date(t.settled_time).getTime(),
        pnl: Number(cumulative.toFixed(4)),
      });
    }

    const nowTs = this.now().getTime();
    const withOpen = Number((cumulative + Number(d.account.openUnrealizedPnlUsd || 0)).toFixed(4));
    points.push({ ts: nowTs, pnl: withOpen });

    return points.length ? points : [{ ts: nowTs, pnl: 0 }];
  });
  readonly allTimePnlStats = computed(() => {
    const points = this.pnlSeries();
    const value = points[points.length - 1]?.pnl ?? 0;
    const investedCapital = this.investedCapital();
    return {
      value,
      pct: investedCapital && investedCapital > 0 ? value / investedCapital : null,
    };
  });
  readonly investedCapital = computed(() => {
    const d = this.data();
    if (!d) return null;
    const investedCapitalUsd = d.account.investedCapitalUsd;
    return investedCapitalUsd !== null && investedCapitalUsd !== undefined && investedCapitalUsd > 0
      ? Number(investedCapitalUsd.toFixed(4))
      : null;
  });

  readonly rangeFilteredSeries = computed(() => {
    const series = this.pnlSeries();
    if (!series.length) return series;
    const range = this.chartRange();
    if (range === 'ALL') return series;

    const nowTs = this.now().getTime();
    let fromTs = 0;

    if (range === 'LIVE') {
      const start = new Date(nowTs);
      start.setHours(0, 0, 0, 0);
      fromTs = start.getTime();
    }
    if (range === '1H') fromTs = nowTs - 1 * 60 * 60 * 1000;
    if (range === '3H') fromTs = nowTs - 3 * 60 * 60 * 1000;
    if (range === '6H') fromTs = nowTs - 6 * 60 * 60 * 1000;
    if (range === '12H') fromTs = nowTs - 12 * 60 * 60 * 1000;
    if (range === '1D') fromTs = nowTs - 24 * 60 * 60 * 1000;
    if (range === '1W') fromTs = nowTs - 7 * 24 * 60 * 60 * 1000;
    if (range === '1M') fromTs = nowTs - 30 * 24 * 60 * 60 * 1000;
    if (range === '3M') fromTs = nowTs - 90 * 24 * 60 * 60 * 1000;
    if (range === '6M') fromTs = nowTs - 182 * 24 * 60 * 60 * 1000;
    if (range === '1Y') fromTs = nowTs - 365 * 24 * 60 * 60 * 1000;
    if (range === '3Y') fromTs = nowTs - 3 * 365 * 24 * 60 * 60 * 1000;
    if (range === '5Y') fromTs = nowTs - 5 * 365 * 24 * 60 * 60 * 1000;
    if (range === 'YTD') {
      const d = new Date(nowTs);
      fromTs = new Date(d.getFullYear(), 0, 1).getTime();
    }

    const filtered = series.filter((p) => p.ts >= fromTs);
    if (!filtered.length) {
      const last = series[Math.max(0, series.length - 1)];
      return [{ ts: fromTs, pnl: last.pnl }, { ts: nowTs, pnl: last.pnl }];
    }

    const firstIndex = series.findIndex((p) => p.ts >= fromTs);
    const points = [...filtered];
    if (firstIndex > 0) {
      points.unshift({ ts: fromTs, pnl: series[firstIndex - 1].pnl });
    } else if (points[0].ts > fromTs) {
      points.unshift({ ts: fromTs, pnl: points[0].pnl });
    }

    if (points[points.length - 1].ts < nowTs) {
      points.push({ ts: nowTs, pnl: points[points.length - 1].pnl });
    }
    return points;
  });

  readonly chartStats = computed(() => {
    const points = this.rangeFilteredSeries();
    const last = points[points.length - 1]?.pnl ?? 0;
    const investedCapital = this.investedCapital();
    const selectedPoints = this.selectedChartPoints();
    const hovered = this.hoveredPoint();
    const comparisonPoints = [...selectedPoints].sort((a, b) => a.ts - b.ts);
    const currentPoint = selectedPoints[selectedPoints.length - 1] || hovered || points[points.length - 1] || null;
    const startPoint = comparisonPoints.length >= 2 ? comparisonPoints[0] : points[0] || null;
    const endPoint = comparisonPoints.length >= 2 ? comparisonPoints[1] : currentPoint;
    const currentValue = currentPoint?.pnl ?? last;
    const currentPct = investedCapital && investedCapital > 0 ? currentValue / investedCapital : null;
    const delta = Number((((endPoint?.pnl ?? currentValue) - (startPoint?.pnl ?? 0)).toFixed(4)));
    const deltaPct = investedCapital && investedCapital > 0 ? delta / investedCapital : null;

    return {
      currentValue,
      currentPct,
      delta,
      deltaPct,
      currentTs: currentPoint?.ts ?? null,
      startTs: startPoint?.ts ?? null,
      endTs: endPoint?.ts ?? null,
      hasSelection: selectedPoints.length > 0,
      selectionCount: selectedPoints.length,
    };
  });
  readonly chartReadout = computed(() => {
    const stats = this.chartStats();
    if (stats.selectionCount >= 2) {
      return {
        value: stats.delta,
        pct: stats.deltaPct,
      };
    }

    return {
      value: stats.currentValue,
      pct: stats.currentPct,
    };
  });
  readonly chartNetAccountValue = computed(() => {
    const d = this.data();
    if (!d) return null;
    const currentNetAccountValue = this.netAccountValue();
    if (currentNetAccountValue === null) return null;
    const allTimePnl = this.allTimePnlStats().value;
    return Number((currentNetAccountValue - allTimePnl + this.chartStats().currentValue).toFixed(2));
  });

  constructor() {
    effect(() => {
      if (!this.chartViewReady()) return;
      this.theme();
      this.chartRange();
      this.rangeFilteredSeries();
      queueMicrotask(() => this.renderChart());
    });

    effect(() => {
      const theme = this.theme();
      document.documentElement.setAttribute('data-theme', theme);
      document.body.setAttribute('data-theme', theme);
    });

    this.fetchDashboard();
    this.refreshTimer = setInterval(() => {
      this.now.set(new Date());
      this.fetchDashboard();
    }, 5000);
  }

  ngAfterViewInit(): void {
    this.chartViewReady.set(true);
    this.renderChart();
  }

  ngOnDestroy(): void {
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    if (this.chartInstance) {
      this.chartInstance.destroy();
      this.chartInstance = null;
    }
  }

  private loadTheme(): ThemeMode {
    try {
      const stored = localStorage.getItem('dashboardTheme');
      if (stored === 'light' || stored === 'dark') return stored;
    } catch {
      // Ignore storage errors and fallback to light mode.
    }
    return 'light';
  }

  toggleTheme(): void {
    const next: ThemeMode = this.theme() === 'light' ? 'dark' : 'light';
    this.theme.set(next);
    try {
      localStorage.setItem('dashboardTheme', next);
    } catch {
      // Ignore storage write errors.
    }
  }

  setChartRange(range: ChartRange): void {
    this.chartRange.set(range);
    this.hoveredPoint.set(null);
    this.selectedChartPoints.set([]);
  }

  @HostListener('document:click', ['$event'])
  onDocumentClick(event: MouseEvent): void {
    const target = event.target as Node | null;
    const chartWrapEl = this.chartWrap?.nativeElement;
    if (!target || !chartWrapEl) return;
    if (chartWrapEl.contains(target)) return;
    if (this.selectedChartPoints().length) {
      this.selectedChartPoints.set([]);
      this.hoveredPoint.set(null);
    }
  }

  setLogViewMode(mode: LogViewMode): void {
    this.logViewMode.set(mode);
  }

  setLogTimeRange(range: LogTimeRange): void {
    this.logTimeRange.set(range);
  }

  setTableSort(table: TableId, key: string): void {
    this.tableSort.update((current) => {
      const existing = current[table];
      const defaultSort = DEFAULT_TABLE_SORT[table];
      let nextSort: TableSortState;
      if (existing.key !== key) {
        nextSort = { key, direction: 'desc' };
      } else if (existing.direction === 'desc') {
        nextSort = { key, direction: 'asc' };
      } else {
        nextSort = { ...defaultSort };
      }
      return {
        ...current,
        [table]: nextSort,
      };
    });
  }

  sortIndicator(table: TableId, key: string): string {
    const current = this.tableSort()[table];
    if (current.key !== key) return '↕';
    const defaultSort = DEFAULT_TABLE_SORT[table];
    if (current.key === defaultSort.key && current.direction === defaultSort.direction) return '↕';
    return current.direction === 'asc' ? '↑' : '↓';
  }

  private formatChartTs(ts: number, range: ChartRange): string {
    const d = new Date(ts);
    if (range === '1H' || range === '3H' || range === '6H' || range === '12H' || range === 'LIVE') {
      return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    }
    if (range === '1D') return d.toLocaleTimeString([], { hour: 'numeric' });
    if (range === '1W' || range === '1M') return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
    return d.toLocaleDateString([], { month: 'short', year: '2-digit' });
  }

  private formatReadoutTs(ts: number): string {
    return new Date(ts).toLocaleString([], {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    });
  }

  private rangeStartTs(nowTs: number, range: ChartRange): number | null {
    if (range === 'ALL') return null;
    if (range === 'LIVE') {
      const start = new Date(nowTs);
      start.setHours(0, 0, 0, 0);
      return start.getTime();
    }
    if (range === '1H') return nowTs - 1 * 60 * 60 * 1000;
    if (range === '3H') return nowTs - 3 * 60 * 60 * 1000;
    if (range === '6H') return nowTs - 6 * 60 * 60 * 1000;
    if (range === '12H') return nowTs - 12 * 60 * 60 * 1000;
    if (range === '1D') return nowTs - 24 * 60 * 60 * 1000;
    if (range === '1W') return nowTs - 7 * 24 * 60 * 60 * 1000;
    if (range === '1M') return nowTs - 30 * 24 * 60 * 60 * 1000;
    if (range === '3M') return nowTs - 90 * 24 * 60 * 60 * 1000;
    if (range === '6M') return nowTs - 182 * 24 * 60 * 60 * 1000;
    if (range === '1Y') return nowTs - 365 * 24 * 60 * 60 * 1000;
    if (range === '3Y') return nowTs - 3 * 365 * 24 * 60 * 60 * 1000;
    if (range === '5Y') return nowTs - 5 * 365 * 24 * 60 * 60 * 1000;
    if (range === 'YTD') {
      const d = new Date(nowTs);
      return new Date(d.getFullYear(), 0, 1).getTime();
    }
    return null;
  }

  fetchDashboard(): void {
    const runtime = getDashboardRuntimeConfig();
    const headers = runtime.apiToken ? { Authorization: `Bearer ${runtime.apiToken}` } : undefined;

    this.http.get<DashboardPayload>(buildApiUrl('/api/dashboard'), { headers }).subscribe({
      next: (payload) => {
        this.data.set(payload);
        queueMicrotask(() => this.renderChart());
        this.loading.set(false);
        this.error.set(null);
      },
      error: (err) => {
        this.loading.set(false);
        this.error.set(err?.message || 'Failed to load dashboard data');
      },
    });
  }

  trackByTicker(index: number, row: { ticker: string }): string {
    return `${row.ticker}-${index}`;
  }

  numberTone(value: unknown): 'pos' | 'neg' | '' {
    if (typeof value !== 'number' || !Number.isFinite(value) || value === 0) return '';
    return value > 0 ? 'pos' : 'neg';
  }

  asString(value: unknown): string {
    if (typeof value === 'string') return value;
    if (value === null || value === undefined) return '-';
    if (typeof value === 'number') return String(value);
    if (typeof value === 'boolean') return value ? 'true' : 'false';
    return JSON.stringify(value);
  }

  prettyKey(key: string): string {
    return key
      .replace(/([a-z])([A-Z])/g, '$1 $2')
      .replace(/_/g, ' ')
      .replace(/\b\w/g, (char) => char.toUpperCase());
  }

  logActionLabel(action: string | undefined): string {
    return String(action || 'unknown').replace(/_/g, ' ').toUpperCase();
  }

  logActionTone(action: string | undefined): string {
    const value = String(action || '');
    if (value.includes('error') || value.includes('halt') || value.includes('fatal')) return 'log-action--bad';
    if (value.includes('filled')) return 'log-action--good';
    if (value.includes('submit')) return 'log-action--info';
    if (value.includes('not_filled')) return 'log-action--warn';
    return 'log-action--neutral';
  }

  logHeadline(item: LogRecord): string {
    const message = item['message'];
    if (typeof message === 'string' && message.trim()) return message;

    const eventTitle = item['eventTitle'];
    if (typeof eventTitle === 'string' && eventTitle.trim()) {
      const minute = item['minute'];
      const score = item['score'];
      const bits = [
        eventTitle.trim(),
        minute !== undefined && minute !== null ? `${minute}'` : null,
        typeof score === 'string' && score ? score : null,
      ].filter(Boolean);
      return bits.join(' • ');
    }

    const competition = item['competition'];
    if (typeof competition === 'string' && competition.trim()) return competition.trim();
    return this.logActionLabel(item.action);
  }

  logFields(item: LogRecord): LogField[] {
    return Object.entries(item)
      .filter(([key]) => key !== 'ts' && key !== 'action' && key !== 'message')
      .map(([key, value]) => ({
        key,
        label: this.prettyKey(key),
        value: this.asString(value),
      }));
  }

  private sortRows<T>(
    rows: T[],
    sort: TableSortState,
    accessors: Record<string, (row: T) => unknown>,
  ): T[] {
    const accessor = accessors[sort.key];
    if (!accessor) return [...rows];
    const multiplier = sort.direction === 'asc' ? 1 : -1;
    return [...rows].sort((left, right) => {
      const primary = this.compareValues(accessor(left), accessor(right)) * multiplier;
      if (primary !== 0) return primary;
      return this.compareValues(JSON.stringify(left), JSON.stringify(right));
    });
  }

  private compareValues(left: unknown, right: unknown): number {
    if (left === right) return 0;
    if (left === null || left === undefined || left === '') return 1;
    if (right === null || right === undefined || right === '') return -1;
    if (typeof left === 'number' && typeof right === 'number') return left - right;
    if (typeof left === 'boolean' && typeof right === 'boolean') return Number(left) - Number(right);
    return String(left).localeCompare(String(right), undefined, { numeric: true, sensitivity: 'base' });
  }

  private toTimestamp(value: string | null | undefined): number | null {
    if (!value) return null;
    const ts = new Date(value).getTime();
    return Number.isFinite(ts) ? ts : null;
  }

  logPrimaryFields(item: LogRecord): LogField[] {
    const priority = [
      'eventTitle',
      'competition',
      'leadingTeam',
      'score',
      'minute',
      'stakeUsd',
      'fillCount',
      'count',
      'cards',
      'leaderVsTrailingCards',
    ];
    const fields = this.logFields(item);
    return priority
      .map((key) => fields.find((field) => field.key === key))
      .filter((field): field is LogField => Boolean(field));
  }

  logSecondaryFields(item: LogRecord): LogField[] {
    const primaryKeys = new Set(this.logPrimaryFields(item).map((field) => field.key));
    return this.logFields(item).filter((field) => !primaryKeys.has(field.key));
  }

  statusClass(status: string | undefined): string {
    switch (status) {
      case 'UP_TRADING':
        return 'status-good';
      case 'UP_DRY_RUN':
        return 'status-info';
      case 'UP_BLOCKED_STOP_LOSS':
        return 'status-warn';
      case 'UP_DEGRADED':
        return 'status-bad';
      case 'DOWN':
        return 'status-down';
      default:
        return 'status-neutral';
    }
  }

  agentStatusLabel(status: string | undefined): string {
    switch (status) {
      case 'UP_TRADING':
        return 'Live Trading';
      case 'UP_DRY_RUN':
        return 'Paper Trading';
      case 'UP_BLOCKED_STOP_LOSS':
        return 'Paused for Stop-Loss';
      case 'UP_DEGRADED':
        return 'Running with Issues';
      case 'DOWN':
        return 'Offline';
      case 'STARTING':
        return 'Starting Up';
      default:
        return 'Checking Status';
    }
  }

  private renderChart(): void {
    const canvas = this.chartCanvas?.nativeElement;
    if (!canvas) return;
    canvas.onmouseleave = () => this.hoveredPoint.set(null);

    if (this.chartInstance && this.chartInstance.canvas !== canvas) {
      this.chartInstance.destroy();
      this.chartInstance = null;
    }

    const points = this.rangeFilteredSeries();
    this.chartPoints = points;
    const delta = this.chartStats().delta;
    const colors = this.theme() === 'dark'
      ? { grid: '#1f2d40', text: '#9aa5b1', line: delta >= 0 ? '#00c805' : '#ff5000' }
      : { grid: '#e6e9ed', text: '#6f7277', line: delta >= 0 ? '#00c805' : '#ff5000' };

    const labels = points.map((pt) => this.formatChartTs(pt.ts, this.chartRange()));
    const values = points.map((pt) => Number(pt.pnl.toFixed(4)));
    const currency = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 });

    if (!this.chartInstance) {
      const config: ChartConfiguration<'line'> = {
        type: 'line',
        plugins: [this.chartSelectionPlugin],
        data: {
          labels,
          datasets: [
            {
              data: values,
              borderColor: colors.line,
              pointBackgroundColor: colors.line,
              borderWidth: 3,
              pointRadius: 0,
              pointHoverRadius: 5,
              pointHitRadius: 16,
              tension: 0.35,
              cubicInterpolationMode: 'monotone',
              fill: false,
            },
          ],
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          animation: false,
          interaction: {
            mode: 'index',
            intersect: false,
          },
          plugins: {
            legend: { display: false },
            tooltip: { enabled: false },
          },
          onHover: (_event, activeElements) => {
            if (this.selectedChartPoints().length) return;
            if (!activeElements.length) {
              this.hoveredPoint.set(null);
              return;
            }
            const idx = activeElements[0].index;
            this.hoveredPoint.set(this.chartPoints[idx] || null);
          },
          onClick: (_event, activeElements) => {
            if (!activeElements.length) return;
            const idx = activeElements[0].index;
            const point = this.chartPoints[idx];
            if (!point) return;
            this.selectedChartPoints.update((current) => {
              if (current.length < 2) return [...current, point];
              return [current[1], point];
            });
            this.hoveredPoint.set(point);
          },
          scales: {
            x: {
              grid: { display: false },
              ticks: {
                color: colors.text,
                maxTicksLimit: 6,
              },
            },
            y: {
              display: false,
              border: { display: false },
              grid: { display: false },
              ticks: { display: false },
            },
          },
        },
      };
      this.chartInstance = new Chart(canvas, config);
      return;
    }

    this.chartInstance.data.labels = labels;
    this.chartInstance.data.datasets[0].data = values;
    this.chartInstance.data.datasets[0].borderColor = colors.line;
    this.chartInstance.data.datasets[0].pointBackgroundColor = colors.line;
    this.chartInstance.options.scales = {
      x: {
        grid: { display: false },
        ticks: {
          color: colors.text,
          maxTicksLimit: 6,
        },
      },
      y: {
        display: false,
        border: { display: false },
        grid: { display: false },
        ticks: { display: false },
      },
    };
    this.chartInstance.options.onHover = (_event, activeElements) => {
      if (this.selectedChartPoints().length) return;
      if (!activeElements.length) {
        this.hoveredPoint.set(null);
        return;
      }
      const idx = activeElements[0].index;
      this.hoveredPoint.set(this.chartPoints[idx] || null);
    };
    this.chartInstance.options.onClick = (_event, activeElements) => {
      if (!activeElements.length) return;
      const idx = activeElements[0].index;
      const point = this.chartPoints[idx];
      if (!point) return;
      this.selectedChartPoints.update((current) => {
        if (current.length < 2) return [...current, point];
        return [current[1], point];
      });
      this.hoveredPoint.set(point);
    };
    this.chartInstance.update('none');
  }
}
