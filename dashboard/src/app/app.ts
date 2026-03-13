import { CommonModule, CurrencyPipe, DatePipe, PercentPipe } from '@angular/common';
import { HttpClient } from '@angular/common/http';
import { Component, computed, effect, ElementRef, inject, OnDestroy, signal, ViewChild } from '@angular/core';
import {
  CategoryScale,
  Chart,
  Filler,
  Legend,
  LineController,
  LineElement,
  LinearScale,
  PointElement,
  Tooltip,
  type ChartConfiguration,
} from 'chart.js';

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
  selection_label?: string | null;
  market_title?: string | null;
  market_status?: string | null;
  position_fp?: string;
  side?: string;
  quantity?: number;
  cost_basis_usd?: number;
  amount_bet_usd?: number;
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
    leadingTeam?: string | null;
    eventTitle?: string | null;
    selectedOutcome?: string | null;
    markedAt?: string;
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
    leadingTeam?: string | null;
    eventTitle?: string | null;
    selectedOutcome?: string | null;
    markedAt?: string;
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

interface RecoveryLadderRow {
  stakeUsd: number;
  trades: number;
  wins: number;
  losses: number;
  pushes: number;
  lossUsdAbs: number;
  winUsd: number;
  netPnlUsd: number;
  avgWinUsd: number | null;
  prevTierStakeUsd: number | null;
  prevTierLossUsd: number;
  remainingLossUsd?: number;
  winsNeededToOffsetPrevTierLosses: number | null;
}

interface RecoveryAnalytics {
  enabled: boolean;
  baseStakeUsd: number;
  recoveryStakeUsd: number;
  recoveryMaxStakeUsd?: number;
  currentLossStreak: number;
  recoveryLossBalanceUsd: number;
  nextStakeUsd: number;
  ladder: RecoveryLadderRow[];
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
  redCards: string | null;
  leadingVsTrailingRedCards: string | null;
  leadingTeam: string;
  goalDiff: number | null;
  status: 'ELIGIBLE_NOW' | 'ALREADY_BET' | 'WATCHING' | 'FILTERED' | 'NO_LIVE_DATA';
  reason: string;
}

type ThemeMode = 'light' | 'dark';
type ChartRange = '1H' | '3H' | '6H' | '12H' | 'LIVE' | '1D' | '1W' | '1M' | '3M' | 'YTD' | '1Y' | 'ALL';
type LogViewMode = 'important' | 'verbose';
type LogTimeRange = 'TODAY' | '24H' | '7D' | 'ALL';

interface PnlPoint {
  ts: number;
  pnl: number;
}

interface MetricCard {
  label: string;
  value: number | null;
  format: 'usd' | 'pct' | 'num';
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
  private chartInstance: Chart<'line'> | null = null;
  private chartPoints: PnlPoint[] = [];
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
  readonly chartRanges: ChartRange[] = ['1H', '3H', '6H', '12H', 'LIVE', '1D', '1W', '1M', '3M', 'YTD', '1Y', 'ALL'];
  readonly logTimeRanges: LogTimeRange[] = ['TODAY', '24H', '7D', 'ALL'];
  readonly hoveredPoint = signal<PnlPoint | null>(null);
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

  readonly botPerformanceMetrics = computed<MetricCard[]>(() => {
    const d = this.data();
    if (!d) return [];
    return [
      { label: 'Available Balance', value: d.account.balanceUsd, format: 'usd' },
      { label: 'Portfolio Value', value: d.account.portfolioValueUsd, format: 'usd' },
      { label: 'Today PnL', value: d.account.pnlTodayUsd, format: 'usd' },
      { label: 'Realized PnL', value: d.account.pnl14dUsd, format: 'usd' },
      { label: 'Open ROI PnL', value: d.account.openUnrealizedPnlUsd, format: 'usd' },
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

  readonly recoveryMetrics = computed<MetricCard[]>(() => {
    const d = this.data();
    if (!d) return [];
    return [
      { label: 'Next Stake', value: d.recovery?.nextStakeUsd ?? d.bot.currentStakeUsd ?? null, format: 'usd' },
      { label: 'Loss Streak', value: d.recovery?.currentLossStreak ?? d.bot.recoveryLossStreak ?? 0, format: 'num' },
      { label: 'Recovery Loss $', value: d.recovery?.recoveryLossBalanceUsd ?? d.bot.recoveryLossBalanceUsd ?? 0, format: 'usd' },
      { label: 'Wins / Single Loss', value: d.analytics.winsRequiredToRecoverSingleLoss, format: 'num' },
      { label: 'Wins To Breakeven', value: d.analytics.winsRequiredToBreakeven, format: 'num' },
      { label: 'Settled Trades', value: d.analytics.settledTrades, format: 'num' },
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

  readonly rangeFilteredSeries = computed(() => {
    const series = this.pnlSeries();
    if (!series.length) return series;
    const range = this.chartRange();
    if (range === 'ALL') return series;

    const nowTs = this.now().getTime();
    let fromTs = 0;

    if (range === '1H') fromTs = nowTs - 1 * 60 * 60 * 1000;
    if (range === '3H') fromTs = nowTs - 3 * 60 * 60 * 1000;
    if (range === '6H') fromTs = nowTs - 6 * 60 * 60 * 1000;
    if (range === '12H') fromTs = nowTs - 12 * 60 * 60 * 1000;
    if (range === 'LIVE') fromTs = nowTs - 6 * 60 * 60 * 1000;
    if (range === '1D') fromTs = nowTs - 24 * 60 * 60 * 1000;
    if (range === '1W') fromTs = nowTs - 7 * 24 * 60 * 60 * 1000;
    if (range === '1M') fromTs = nowTs - 30 * 24 * 60 * 60 * 1000;
    if (range === '3M') fromTs = nowTs - 90 * 24 * 60 * 60 * 1000;
    if (range === '1Y') fromTs = nowTs - 365 * 24 * 60 * 60 * 1000;
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
    const first = points[0]?.pnl ?? 0;
    const last = points[points.length - 1]?.pnl ?? 0;
    const delta = Number((last - first).toFixed(4));
    const deltaPct = Math.abs(first) > 0 ? delta / Math.abs(first) : null;
    const hovered = this.hoveredPoint();

    return {
      currentValue: hovered?.pnl ?? last,
      delta,
      deltaPct,
      currentTs: hovered?.ts ?? points[points.length - 1]?.ts ?? null,
    };
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
  }

  setLogViewMode(mode: LogViewMode): void {
    this.logViewMode.set(mode);
  }

  setLogTimeRange(range: LogTimeRange): void {
    this.logTimeRange.set(range);
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

  fetchDashboard(): void {
    this.http.get<DashboardPayload>('/api/dashboard').subscribe({
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

  private renderChart(): void {
    const canvas = this.chartCanvas?.nativeElement;
    if (!canvas) return;

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
            if (!activeElements.length) {
              this.hoveredPoint.set(null);
              return;
            }
            const idx = activeElements[0].index;
            this.hoveredPoint.set(this.chartPoints[idx] || null);
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
                border: { display: false },
                grid: {
                  color: colors.grid,
                },
                ticks: {
                  color: colors.text,
                  callback: (value) => currency.format(Number(value)),
              },
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
        border: { display: false },
        grid: {
          color: colors.grid,
        },
        ticks: {
          color: colors.text,
          callback: (value) => currency.format(Number(value)),
        },
      },
    };
    this.chartInstance.update('none');
  }
}
