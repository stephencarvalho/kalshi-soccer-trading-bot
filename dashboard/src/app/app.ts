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
type ChartRange = 'LIVE' | '1D' | '1W' | '1M' | '3M' | 'YTD' | '1Y' | 'ALL';

interface PnlPoint {
  ts: number;
  pnl: number;
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
  @ViewChild('pnlChart') private chartCanvas?: ElementRef<HTMLCanvasElement>;
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
  readonly chartRanges: ChartRange[] = ['LIVE', '1D', '1W', '1M', '3M', 'YTD', '1Y', 'ALL'];
  readonly hoveredPoint = signal<PnlPoint | null>(null);

  readonly kpi = computed(() => {
    const d = this.data();
    if (!d) return null;

    return [
      { label: 'Available Balance', value: d.account.balanceUsd, format: 'usd' },
      { label: 'Portfolio Value', value: d.account.portfolioValueUsd, format: 'usd' },
      { label: 'Open Positions', value: d.account.openPositionsCount, format: 'num' },
      { label: 'Today PnL', value: d.account.pnlTodayUsd, format: 'usd' },
      { label: 'Realized PnL', value: d.account.pnl14dUsd, format: 'usd' },
      { label: 'Open ROI PnL', value: d.account.openUnrealizedPnlUsd, format: 'usd' },
      { label: 'Open ROI %', value: d.account.openRoiPct, format: 'pct' },
      { label: 'Fill Rate', value: d.metrics.fillRate, format: 'pct' },
      { label: 'Orders Submitted', value: d.metrics.totalOrderSubmit, format: 'num' },
      { label: 'Orders Filled', value: d.metrics.totalFilled, format: 'num' },
      { label: 'Eligible Games', value: d.monitoredGamesSummary.eligibleNow, format: 'num' },
      { label: 'Settled Trades', value: d.analytics.settledTrades, format: 'num' },
      { label: 'Next Stake', value: d.recovery?.nextStakeUsd ?? d.bot.currentStakeUsd ?? null, format: 'usd' },
      { label: 'Loss Streak', value: d.recovery?.currentLossStreak ?? d.bot.recoveryLossStreak ?? 0, format: 'num' },
      { label: 'Recovery Loss $', value: d.recovery?.recoveryLossBalanceUsd ?? d.bot.recoveryLossBalanceUsd ?? 0, format: 'usd' },
    ];
  });

  readonly analyticsCards = computed(() => {
    const d = this.data();
    if (!d) return null;

    return [
      { label: 'Settled Trades', value: d.analytics.settledTrades, format: 'num' },
      { label: 'Win Rate', value: d.analytics.winRate, format: 'pct' },
      { label: 'Avg Winner ROI', value: d.analytics.avgWinnerRoiPct, format: 'pct' },
      { label: 'Avg Loss (Abs)', value: d.analytics.avgLossAbsUsd, format: 'usd' },
      { label: 'Expectancy / Trade', value: d.analytics.expectancyPerTradeUsd, format: 'usd' },
      { label: 'Recover Avg Loss', value: d.analytics.betsNeededToRecoverAvgLoss, format: 'num' },
      { label: 'Breakeven Win Rate', value: d.analytics.breakevenWinRate, format: 'pct' },
      { label: 'Profit Factor', value: d.analytics.profitFactor, format: 'num2' },
      { label: 'Payoff Ratio', value: d.analytics.payoffRatio, format: 'num2' },
      { label: 'Max Drawdown', value: d.analytics.maxDrawdownUsd, format: 'usd' },
      { label: 'Longest Win Streak', value: d.analytics.longestWinStreak, format: 'num' },
      { label: 'Longest Loss Streak', value: d.analytics.longestLossStreak, format: 'num' },
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

  readonly summaryCards = computed(() => {
    const d = this.data();
    if (!d) return [];
    return [
      { label: 'Win Rate', value: d.analytics.winRate, format: 'pct' },
      { label: 'Avg Winner ROI', value: d.analytics.avgWinnerRoiPct, format: 'pct' },
      { label: 'Avg $ ROI / Win', value: d.analytics.avgWinRoiUsd, format: 'usd' },
      { label: 'Expectancy / Trade', value: d.analytics.expectancyPerTradeUsd, format: 'usd' },
      { label: 'Wins / Single Loss', value: d.analytics.winsRequiredToRecoverSingleLoss, format: 'num' },
      { label: 'Wins To Breakeven', value: d.analytics.winsRequiredToBreakeven, format: 'num' },
    ];
  });

  constructor() {
    effect(() => {
      if (!this.chartViewReady()) return;
      this.theme();
      this.chartRange();
      this.rangeFilteredSeries();
      queueMicrotask(() => this.renderChart());
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

  private formatChartTs(ts: number, range: ChartRange): string {
    const d = new Date(ts);
    if (range === 'LIVE') return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    if (range === '1D') return d.toLocaleTimeString([], { hour: 'numeric' });
    if (range === '1W' || range === '1M') return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
    return d.toLocaleDateString([], { month: 'short', year: '2-digit' });
  }

  fetchDashboard(): void {
    this.http.get<DashboardPayload>('/api/dashboard').subscribe({
      next: (payload) => {
        this.data.set(payload);
        this.renderChart();
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
