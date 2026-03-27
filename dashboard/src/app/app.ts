import {
  CommonModule,
  CurrencyPipe,
  DatePipe,
  PercentPipe,
} from "@angular/common";
import { HttpErrorResponse } from "@angular/common/http";
import { HttpClient } from "@angular/common/http";
import {
  Component,
  computed,
  effect,
  ElementRef,
  HostListener,
  inject,
  OnDestroy,
  signal,
  ViewChild,
} from "@angular/core";
import { FontAwesomeModule } from "@fortawesome/angular-fontawesome";
import { faGear } from "@fortawesome/free-solid-svg-icons";
import type {
  AuthChangeEvent,
  RealtimeChannel,
  Session,
  User,
} from "@supabase/supabase-js";
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
} from "chart.js";
import { buildApiUrl, getDashboardRuntimeConfig } from "./runtime-config";
import {
  getSupabaseBrowserClient,
  isSupabaseBrowserAuthConfigured,
} from "./supabase";

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
    ignoreDailyLossLimit?: boolean;
    recoveryModeEnabled?: boolean;
    recoveryStakeUsd?: number;
    recoveryMaxStakeUsd?: number;
    recoveryConditions?: string[];
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
    riskHaltLoggedToday?: boolean;
    riskHaltOverrideActive?: boolean;
    status:
      | "STARTING"
      | "UP_TRADING"
      | "UP_DRY_RUN"
      | "UP_BLOCKED_STOP_LOSS"
      | "UP_DEGRADED"
      | "DOWN";
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
    totalBetsPlaced: number;
    totalFilled: number;
    totalNotFilled: number;
    totalErrors: number;
    fillRate: number;
  };
  analytics: TradeAnalytics;
  recovery?: RecoveryAnalytics;
  leagueLeaderboard: LeagueLeaderboardRow[];
  strategyLeaderboard: StrategyLeaderboardRow[];
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

interface DashboardSnapshotRecord {
  payload: DashboardPayload | null;
}

interface RuntimeSizingResponse {
  ok: boolean;
  config: {
    stakeUsd: number;
    recoveryStakeUsd?: number;
    recoveryMaxStakeUsd: number;
    maxDailyLossUsd: number;
  };
}

interface RuntimeModeResponse {
  ok: boolean;
  mode: RuntimeMode;
  config: {
    dryRun: boolean;
    tradingEnabled: boolean;
  };
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
    competition?: string | null;
    eventTitle?: string | null;
    selectedOutcome?: string | null;
    markedAt?: string;
    tradeLegId?: string | null;
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
    competition?: string | null;
    eventTitle?: string | null;
    selectedOutcome?: string | null;
    markedAt?: string;
    tradeLegId?: string | null;
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
  targetProfitUsd?: number | null;
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
  recoveryAttempts?: RecoveryTradeLink[];
  recoverySettlements?: RecoveryTradeLink[];
  recoveryBetResultUsd: number | null;
  resolutionTrade: RecoveryTradeLink | null;
}

interface RecoveryAttemptView {
  tradeKey: string;
  eventTitle: string;
  competition: string;
  status: "OPEN" | "SETTLED";
  observedAt: string | null;
  amountBetUsd: number | null;
  stakeUsdTarget: number | null;
  targetProfitUsd: number | null;
  yesPrice: number | null;
  contracts: number | null;
  pnlUsd: number | null;
  allocatedRecoveryUsd: number;
}

interface RecoveryCreditView {
  tradeKey: string;
  eventTitle: string;
  competition: string;
  settledTime: string | null;
  pnlUsd: number | null;
  allocatedRecoveryUsd: number;
  sourceLabel: string;
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

interface StrategyLeaderboardRow {
  strategy: string;
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
  homeNoPrice?: number | null;
  awayYesPrice?: number | null;
  awayNoPrice?: number | null;
  tieYesPrice?: number | null;
  tieNoPrice?: number | null;
  redCards: string | null;
  leadingVsTrailingRedCards: string | null;
  leadingTeam: string;
  goalDiff: number | null;
  status:
    | "ELIGIBLE_NOW"
    | "ELIGIBLE_NO_CAPACITY"
    | "ALREADY_BET"
    | "WATCHING"
    | "FILTERED"
    | "NO_LIVE_DATA";
  reason: string;
}

type ThemeMode = "light" | "dark";
type RuntimeMode = "paper" | "live";
type ChartRange =
  | "LIVE"
  | "1H"
  | "3H"
  | "6H"
  | "12H"
  | "1D"
  | "1W"
  | "1M"
  | "3M"
  | "6M"
  | "YTD"
  | "1Y"
  | "3Y"
  | "5Y"
  | "ALL";
type LogViewMode = "important" | "verbose";
type LogTimeRange = "TODAY" | "24H" | "7D" | "ALL";
type SortDirection = "asc" | "desc";
type TableId =
  | "monitoredGames"
  | "openTrades"
  | "recoveryQueue"
  | "leagueLeaderboard"
  | "strategyLeaderboard"
  | "closedTrades";

interface TableSortState {
  key: string;
  direction: SortDirection;
}

const DEFAULT_TABLE_SORT: Record<TableId, TableSortState> = {
  monitoredGames: { key: "minute", direction: "desc" },
  openTrades: { key: "lastUpdated", direction: "desc" },
  recoveryQueue: { key: "remainingTargetUsd", direction: "desc" },
  leagueLeaderboard: { key: "avgRoiPct", direction: "desc" },
  strategyLeaderboard: { key: "totalPnlUsd", direction: "desc" },
  closedTrades: { key: "settledTime", direction: "desc" },
};

const MIN_STAKE_USD = 0.1;
const MIN_RECOVERY_MAX_STAKE_USD = 2;
const MIN_DAILY_STOP_LOSS_USD = 1;
const MAX_STAKE_USD = 20;
const MAX_RECOVERY_MAX_STAKE_USD = 100;
const DEFAULT_BASE_STAKE_USD = 1;
const DEFAULT_RECOVERY_MAX_STAKE_USD = 20;
const DEFAULT_MAX_DAILY_LOSS_USD = 50;

interface PnlPoint {
  ts: number;
  pnl: number;
}

interface MetricCard {
  label: string;
  value: number | null;
  format: "usd" | "pct" | "num";
  secondaryPct?: number | null;
}

interface HeaderMetric {
  label: string;
  value: string;
  tone?: "pos" | "neg" | "";
}

interface MetricSection {
  title: string;
  subtitle: string;
  columns?: "three" | "four";
  cards: MetricCard[];
}

interface RuntimeSizingValidation {
  baseStakeUsd: number | null;
  recoveryMaxStakeUsd: number | null;
  maxDailyLossUsd: number | null;
  minRecoveryMaxUsd: number;
  valid: boolean;
  message: string | null;
}

interface LogField {
  key: string;
  label: string;
  value: string;
}

interface PasswordRule {
  label: string;
  met: boolean;
}

interface CredentialStatus {
  configured: boolean;
  hasCredential: boolean;
  kalshiApiKeyIdMasked: string | null;
  pemFileName: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  keyVersion: number | null;
}

interface CredentialBannerState {
  tone: "attention" | "setup";
  title: string;
  subtitle: string;
}

type CredentialHealthState = "idle" | "checking" | "healthy" | "failed";

Chart.register(
  LineController,
  LineElement,
  PointElement,
  LinearScale,
  CategoryScale,
  Tooltip,
  Legend,
  Filler,
);

@Component({
  selector: "app-root",
  imports: [
    CommonModule,
    DatePipe,
    CurrencyPipe,
    PercentPipe,
    FontAwesomeModule,
  ],
  templateUrl: "./app.html",
  styleUrl: "./app.scss",
})
export class App implements OnDestroy {
  private readonly http = inject(HttpClient);
  private readonly supabase = getSupabaseBrowserClient();
  readonly faGear = faGear;
  @ViewChild("pnlChart")
  set chartCanvasRef(value: ElementRef<HTMLCanvasElement> | undefined) {
    this.chartCanvas = value;
    if (value) {
      queueMicrotask(() => this.renderChart());
    }
  }
  private chartCanvas?: ElementRef<HTMLCanvasElement>;
  @ViewChild("chartWrap") private chartWrap?: ElementRef<HTMLElement>;
  private chartInstance: Chart<"line"> | null = null;
  private chartPoints: PnlPoint[] = [];
  private dashboardRequestId = 0;
  private readonly chartSelectionPlugin = {
    id: "selectionGuides",
    afterDatasetsDraw: (chart: ChartInstance<"line">) => {
      const ctx = chart.ctx;
      const top = chart.chartArea.top;
      const bottom = chart.chartArea.bottom;
      const left = chart.chartArea.left;
      const right = chart.chartArea.right;
      const yScale = chart.scales["y"];

      if (
        yScale &&
        Number.isFinite(yScale.min) &&
        Number.isFinite(yScale.max) &&
        yScale.min <= 0 &&
        yScale.max >= 0
      ) {
        const zeroY = yScale.getPixelForValue(0);
        ctx.save();
        ctx.strokeStyle =
          this.theme() === "dark"
            ? "rgba(154, 165, 177, 0.4)"
            : "rgba(111, 114, 119, 0.4)";
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(left, zeroY);
        ctx.lineTo(right, zeroY);
        ctx.stroke();
        ctx.restore();
      }

      const selected = [...this.selectedChartPoints()].sort(
        (a, b) => a.ts - b.ts,
      );
      const hovered = selected.length ? null : this.hoveredPoint();
      const targets = selected.length ? selected : hovered ? [hovered] : [];
      if (!targets.length) return;
      const datasetMeta = chart.getDatasetMeta(0);

      ctx.save();
      ctx.strokeStyle =
        this.theme() === "dark"
          ? "rgba(154, 165, 177, 0.55)"
          : "rgba(111, 114, 119, 0.55)";
      ctx.lineWidth = 1;

      const xs = [];
      for (const point of targets) {
        const idx = this.chartPoints.findIndex(
          (candidate) =>
            candidate.ts === point.ts && candidate.pnl === point.pnl,
        );
        const element = idx >= 0 ? datasetMeta.data[idx] : null;
        const x = element?.x;
        if (typeof x !== "number") continue;
        xs.push(x);
        ctx.beginPath();
        ctx.moveTo(x, top);
        ctx.lineTo(x, bottom);
        ctx.stroke();
      }

      const label =
        selected.length >= 2
          ? `${this.formatReadoutTs(selected[0].ts)} - ${this.formatReadoutTs(selected[1].ts)}`
          : this.formatReadoutTs((targets[0] || hovered).ts);

      if (label && xs.length) {
        const centerX =
          selected.length >= 2
            ? (Math.min(...xs) + Math.max(...xs)) / 2
            : xs[0];
        const clampedX = Math.min(right - 8, Math.max(left + 8, centerX));
        const labelY = selected.length >= 2 ? top + 8 : Math.max(8, top - 18);
        ctx.fillStyle = this.theme() === "dark" ? "#c7d0d9" : "#5b6470";
        ctx.font = "600 12px Space Grotesk, Manrope, sans-serif";
        ctx.textAlign = "center";
        ctx.textBaseline = "top";
        ctx.fillText(label, clampedX, labelY);
      }

      ctx.restore();
    },
  };
  private readonly chartViewReady = signal(false);
  private refreshTimer: ReturnType<typeof setInterval> | null = null;
  private authSubscription?: { unsubscribe: () => void };
  private dashboardSnapshotChannel: RealtimeChannel | null = null;
  private dashboardSnapshotUserId: string | null = null;
  private credentialHealthTimer: ReturnType<typeof setTimeout> | null = null;
  private credentialHealthRequestId = 0;
  private dashboardLoadingTimer: ReturnType<typeof setInterval> | null = null;
  private runtimeModeSyncTimer: ReturnType<typeof setTimeout> | null = null;
  private dashboardFetchInFlight = false;
  private dashboardRefreshQueued = false;

  readonly loading = signal(true);
  readonly dashboardLoadingElapsedSeconds = signal(0);
  readonly authLoading = signal(isSupabaseBrowserAuthConfigured());
  readonly authError = signal<string | null>(null);
  readonly authMessage = signal<string | null>(null);
  readonly authEmail = signal("");
  readonly authPassword = signal("");
  readonly authConfirmPassword = signal("");
  readonly authMode = signal<"login" | "signup">("login");
  readonly showPassword = signal(false);
  readonly credentialMenuOpen = signal(false);
  readonly userMenuOpen = signal(false);
  readonly session = signal<Session | null>(null);
  readonly user = signal<User | null>(null);
  readonly credentialsLoading = signal(false);
  readonly credentialsSaving = signal(false);
  readonly credentialsError = signal<string | null>(null);
  readonly credentialsMessage = signal<string | null>(null);
  readonly credentialStatusError = signal<string | null>(null);
  readonly credentialStatus = signal<CredentialStatus | null>(null);
  readonly credentialApiKeyId = signal("");
  readonly credentialPem = signal("");
  readonly credentialPemFileName = signal("");
  readonly credentialReplaceMode = signal(false);
  readonly credentialHealthInfoOpen = signal(false);
  readonly credentialHealthState = signal<CredentialHealthState>("idle");
  readonly credentialHealthMessage = signal<string | null>(null);
  readonly credentialDeleteConfirm = signal(false);
  readonly error = signal<string | null>(null);
  readonly data = signal<DashboardPayload | null>(null);
  readonly now = signal(new Date());
  readonly theme = signal<ThemeMode>(this.loadTheme());
  readonly chartRange = signal<ChartRange>("ALL");
  readonly logViewMode = signal<LogViewMode>("important");
  readonly logTimeRange = signal<LogTimeRange>("TODAY");
  readonly settingsOpen = signal(false);
  readonly riskHaltBusy = signal(false);
  readonly sizingBusy = signal(false);
  readonly sizingDirty = signal(false);
  readonly sizingError = signal<string | null>(null);
  readonly runtimeModeBusy = signal(false);
  readonly runtimeModePending = signal<RuntimeMode | null>(null);
  readonly runtimeStakeInput = signal(String(DEFAULT_BASE_STAKE_USD));
  readonly runtimeRecoveryMaxInput = signal(
    String(DEFAULT_RECOVERY_MAX_STAKE_USD),
  );
  readonly runtimeMaxDailyLossInput = signal(
    String(DEFAULT_MAX_DAILY_LOSS_USD),
  );
  readonly tableSort = signal<Record<TableId, TableSortState>>({
    ...DEFAULT_TABLE_SORT,
  });
  readonly chartRanges: ChartRange[] = [
    "LIVE",
    "1H",
    "3H",
    "6H",
    "12H",
    "1D",
    "1W",
    "1M",
    "3M",
    "6M",
    "YTD",
    "1Y",
    "3Y",
    "5Y",
    "ALL",
  ];
  readonly logTimeRanges: LogTimeRange[] = ["TODAY", "24H", "7D", "ALL"];
  readonly hoveredPoint = signal<PnlPoint | null>(null);
  readonly selectedChartPoints = signal<PnlPoint[]>([]);
  readonly passwordRules = computed<PasswordRule[]>(() => {
    const password = this.authPassword();
    return [
      { label: "At least 10 characters", met: password.length >= 10 },
      { label: "One uppercase letter", met: /[A-Z]/.test(password) },
      { label: "One lowercase letter", met: /[a-z]/.test(password) },
      { label: "One number", met: /\d/.test(password) },
      { label: "One special character", met: /[^A-Za-z0-9]/.test(password) },
    ];
  });
  readonly passwordStrength = computed(() => {
    const password = this.authPassword();
    const metCount = this.passwordRules().filter((rule) => rule.met).length;

    if (!password.length) {
      return {
        label: "Enter a password",
        tone: "idle" as const,
        score: 0,
        percent: 0,
      };
    }

    if (metCount <= 2) {
      return {
        label: "Weak",
        tone: "weak" as const,
        score: metCount,
        percent: 25,
      };
    }

    if (metCount === 3 || metCount === 4) {
      return {
        label: "Good",
        tone: "good" as const,
        score: metCount,
        percent: 65,
      };
    }

    return {
      label: "Strong",
      tone: "strong" as const,
      score: metCount,
      percent: 100,
    };
  });
  readonly isSignupPasswordValid = computed(() =>
    this.passwordRules().every((rule) => rule.met),
  );
  readonly passwordsMatch = computed(
    () => this.authPassword() === this.authConfirmPassword(),
  );
  readonly showConfirmPasswordError = computed(
    () =>
      this.authMode() === "signup" &&
      this.authConfirmPassword().length > 0 &&
      !this.passwordsMatch(),
  );
  readonly viewerTimeZoneLabel = (() => {
    const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return timeZone && timeZone.trim() ? timeZone.trim() : "Local time";
  })();
  readonly dashboardLastUpdatedLabel = computed(() => {
    const generatedAt = this.data()?.generatedAt;
    if (!generatedAt) return "Unavailable";

    const date = new Date(generatedAt);
    return Number.isNaN(date.getTime())
      ? "Unavailable"
      : date.toLocaleString([], {
          hour: "numeric",
          minute: "2-digit",
          second: "2-digit",
        });
  });
  readonly sessionStartedAtLabel = computed(() => {
    const ts = this.session()?.user?.last_sign_in_at;
    if (!ts) return "Unavailable";
    const date = new Date(ts);
    return Number.isNaN(date.getTime())
      ? "Unavailable"
      : date.toLocaleString([], {
          month: "short",
          day: "numeric",
          hour: "numeric",
          minute: "2-digit",
        });
  });
  readonly sessionExpiresAtLabel = computed(() => {
    const expiresAt = this.session()?.expires_at;
    if (!expiresAt) return "Unavailable";
    const date = new Date(expiresAt * 1000);
    return Number.isNaN(date.getTime())
      ? "Unavailable"
      : date.toLocaleString([], {
          month: "short",
          day: "numeric",
          hour: "numeric",
          minute: "2-digit",
        });
  });
  readonly visibleLogs = computed(() => {
    const d = this.data();
    if (!d) return [] as LogRecord[];
    const selected =
      this.logViewMode() === "important" ? d.recentLogs : d.recentCycleLogs;
    const nowTs = this.now().getTime();
    const range = this.logTimeRange();
    let fromTs = Number.NEGATIVE_INFINITY;

    if (range === "TODAY") {
      const start = new Date();
      start.setHours(0, 0, 0, 0);
      fromTs = start.getTime();
    } else if (range === "24H") {
      fromTs = nowTs - 24 * 60 * 60 * 1000;
    } else if (range === "7D") {
      fromTs = nowTs - 7 * 24 * 60 * 60 * 1000;
    }

    return selected.filter((item) => {
      const ts = new Date(String(item.ts || "")).getTime();
      return Number.isFinite(ts) ? ts >= fromTs : false;
    });
  });
  readonly runtimeSizingValidation = computed<RuntimeSizingValidation>(() => {
    const d = this.data();
    const baseStakeUsd = this.parseRuntimeSizingInput(this.runtimeStakeInput());
    const recoveryMaxStakeUsd = this.parseRuntimeSizingInput(
      this.runtimeRecoveryMaxInput(),
    );
    const maxDailyLossUsd = this.parseRuntimeSizingInput(
      this.runtimeMaxDailyLossInput(),
    );
    const configuredRecoveryStakeUsd = Number(d?.config?.recoveryStakeUsd ?? 2);
    const minRecoveryMaxUsd = Math.max(
      MIN_RECOVERY_MAX_STAKE_USD,
      baseStakeUsd ?? MIN_STAKE_USD,
      Number.isFinite(configuredRecoveryStakeUsd)
        ? configuredRecoveryStakeUsd
        : MIN_RECOVERY_MAX_STAKE_USD,
    );

    if (baseStakeUsd === null) {
      return {
        baseStakeUsd,
        recoveryMaxStakeUsd,
        maxDailyLossUsd,
        minRecoveryMaxUsd,
        valid: false,
        message: "Base stake must be a number.",
      };
    }

    if (baseStakeUsd < MIN_STAKE_USD || baseStakeUsd > MAX_STAKE_USD) {
      return {
        baseStakeUsd,
        recoveryMaxStakeUsd,
        maxDailyLossUsd,
        minRecoveryMaxUsd,
        valid: false,
        message: `Base stake must stay between $${MIN_STAKE_USD.toFixed(2)} and $${MAX_STAKE_USD.toFixed(2)}.`,
      };
    }

    if (recoveryMaxStakeUsd === null) {
      return {
        baseStakeUsd,
        recoveryMaxStakeUsd,
        maxDailyLossUsd,
        minRecoveryMaxUsd,
        valid: false,
        message: "Recovery max must be a number.",
      };
    }

    if (
      recoveryMaxStakeUsd < minRecoveryMaxUsd ||
      recoveryMaxStakeUsd > MAX_RECOVERY_MAX_STAKE_USD
    ) {
      return {
        baseStakeUsd,
        recoveryMaxStakeUsd,
        maxDailyLossUsd,
        minRecoveryMaxUsd,
        valid: false,
        message: `Recovery max must stay between $${minRecoveryMaxUsd.toFixed(2)} and $${MAX_RECOVERY_MAX_STAKE_USD.toFixed(2)}.`,
      };
    }

    if (maxDailyLossUsd === null) {
      return {
        baseStakeUsd,
        recoveryMaxStakeUsd,
        maxDailyLossUsd,
        minRecoveryMaxUsd,
        valid: false,
        message: "Daily stop-loss must be a number.",
      };
    }

    if (maxDailyLossUsd < MIN_DAILY_STOP_LOSS_USD) {
      return {
        baseStakeUsd,
        recoveryMaxStakeUsd,
        maxDailyLossUsd,
        minRecoveryMaxUsd,
        valid: false,
        message: `Daily stop-loss must stay at or above $${MIN_DAILY_STOP_LOSS_USD.toFixed(2)}.`,
      };
    }

    return {
      baseStakeUsd,
      recoveryMaxStakeUsd,
      maxDailyLossUsd,
      minRecoveryMaxUsd,
      valid: true,
      message: null,
    };
  });
  readonly runtimeSizingHasChanges = computed(() => {
    const d = this.data();
    const validation = this.runtimeSizingValidation();
    if (!d || !validation.valid) return false;
    return (
      Math.abs(
        (validation.baseStakeUsd ?? DEFAULT_BASE_STAKE_USD) -
          Number(d.config.stakeUsd ?? DEFAULT_BASE_STAKE_USD),
      ) > 1e-9 ||
      Math.abs(
        (validation.recoveryMaxStakeUsd ?? DEFAULT_RECOVERY_MAX_STAKE_USD) -
          Number(
            d.config.recoveryMaxStakeUsd ?? DEFAULT_RECOVERY_MAX_STAKE_USD,
          ),
      ) > 1e-9 ||
      Math.abs(
        (validation.maxDailyLossUsd ?? DEFAULT_MAX_DAILY_LOSS_USD) -
          Number(d.config.maxDailyLossUsd ?? DEFAULT_MAX_DAILY_LOSS_USD),
      ) > 1e-9
    );
  });
  readonly sortedMonitoredGames = computed<MonitoredGameRecord[]>(() => {
    const d = this.data();
    if (!d) return [];
    return this.sortRows(
      d.monitoredGames || [],
      this.tableSort().monitoredGames,
      {
        minute: (row) => row.minute,
        competition: (row) => row.competition,
        title: (row) => row.title,
        score: (row) => row.score,
        homeYesNo: (row) => row.homeYesPrice,
        awayYesNo: (row) => row.awayYesPrice,
        tieYesNo: (row) => row.tieYesPrice,
        redCards: (row) => row.redCards,
        leadingTeam: (row) => row.leadingTeam,
        goalDiff: (row) => row.goalDiff,
        status: (row) => row.status,
        reason: (row) => row.reason,
      },
    );
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
      recovery: (row) =>
        row.placed_context?.recoverySourceEventTitle ||
        row.placed_context?.recoveryQueueId,
      cards: (row) => row.placed_context?.placedCards,
      lastUpdated: (row) => this.toTimestamp(row.last_updated_ts),
    });
  });
  readonly directRecoveryAttemptMap = computed<
    Map<string, RecoveryAttemptView[]>
  >(() => {
    const d = this.data();
    const attemptsByQueue = new Map<string, RecoveryAttemptView[]>();
    if (!d) return attemptsByQueue;

    for (const row of d.recovery?.queue || []) {
      attemptsByQueue.set(row.queueId, []);
      for (const attempt of row.recoveryAttempts || []) {
        this.pushRecoveryAttempt(attemptsByQueue, row.queueId, {
          tradeKey: attempt.tradeKey,
          eventTitle: attempt.eventTitle,
          competition: attempt.competition,
          status: "SETTLED",
          observedAt: attempt.settledTime || null,
          amountBetUsd: attempt.amountBetUsd ?? null,
          stakeUsdTarget: attempt.stakeUsdTarget ?? null,
          targetProfitUsd:
            attempt.targetProfitUsd ??
            attempt.targetedRemainingUsdBefore ??
            null,
          yesPrice: attempt.yesPrice ?? null,
          contracts: attempt.contracts ?? null,
          pnlUsd: attempt.pnlUsd,
          allocatedRecoveryUsd: Number(
            (attempt.allocatedRecoveryUsd || 0).toFixed(4),
          ),
        });
      }
    }

    for (const trade of d.closedTrades || []) {
      const queueId = trade.placed_context?.recoveryQueueId;
      if (!queueId) continue;

      this.pushRecoveryAttempt(attemptsByQueue, queueId, {
        tradeKey: this.closedTradeKey(trade),
        eventTitle:
          trade.placed_context?.eventTitle ||
          trade.event_ticker ||
          trade.ticker,
        competition: trade.placed_context?.competition || "Unknown",
        status: "SETTLED",
        observedAt: trade.settled_time || null,
        amountBetUsd: trade.amount_bet_usd ?? trade.total_cost_usd ?? null,
        stakeUsdTarget: trade.placed_context?.stakeUsdTarget ?? null,
        targetProfitUsd: trade.placed_context?.targetProfitUsd ?? null,
        yesPrice: trade.placed_context?.yesPrice ?? null,
        contracts:
          trade.placed_context?.fillCount ??
          this.fpStringToNumber(trade.yes_count_fp) ??
          this.fpStringToNumber(trade.no_count_fp),
        pnlUsd: trade.pnl_usd ?? null,
        allocatedRecoveryUsd: 0,
      });
    }

    for (const trade of d.openTrades || []) {
      const queueId = trade.placed_context?.recoveryQueueId;
      if (!queueId) continue;

      this.pushRecoveryAttempt(attemptsByQueue, queueId, {
        tradeKey: this.openTradeKey(trade),
        eventTitle:
          trade.event_title ||
          trade.placed_context?.eventTitle ||
          trade.event_ticker ||
          trade.ticker,
        competition: trade.placed_context?.competition || "Unknown",
        status: "OPEN",
        observedAt:
          trade.placed_context?.markedAt || trade.last_updated_ts || null,
        amountBetUsd: trade.amount_bet_usd ?? trade.cost_basis_usd ?? null,
        stakeUsdTarget: trade.placed_context?.stakeUsdTarget ?? null,
        targetProfitUsd: trade.placed_context?.targetProfitUsd ?? null,
        yesPrice: trade.placed_context?.yesPrice ?? null,
        contracts: trade.placed_context?.fillCount ?? trade.quantity ?? null,
        pnlUsd: trade.unrealized_pnl_usd ?? null,
        allocatedRecoveryUsd: 0,
      });
    }

    for (const row of d.recovery?.queue || []) {
      const allocatedByTradeKey = new Map(
        (row.recoverySettlements || []).map((settlement) => [
          settlement.tradeKey,
          Number((settlement.allocatedRecoveryUsd || 0).toFixed(4)),
        ]),
      );
      const attempts = attemptsByQueue.get(row.queueId) || [];
      attemptsByQueue.set(
        row.queueId,
        attempts.map((attempt) => ({
          ...attempt,
          allocatedRecoveryUsd:
            allocatedByTradeKey.get(attempt.tradeKey) ??
            attempt.allocatedRecoveryUsd ??
            0,
        })),
      );
    }

    for (const attempts of attemptsByQueue.values()) {
      attempts.sort((left, right) => {
        const leftTs = this.toTimestamp(left.observedAt) ?? 0;
        const rightTs = this.toTimestamp(right.observedAt) ?? 0;
        return leftTs - rightTs;
      });
    }

    return attemptsByQueue;
  });
  readonly recoveryCreditMap = computed<Map<string, RecoveryCreditView[]>>(
    () => {
      const d = this.data();
      const creditsByQueue = new Map<string, RecoveryCreditView[]>();
      if (!d) return creditsByQueue;

      const tradeByKey = new Map(
        (d.closedTrades || []).map((trade) => [
          this.closedTradeKey(trade),
          trade,
        ]),
      );

      for (const row of d.recovery?.queue || []) {
        const credits = (row.recoverySettlements || []).map((settlement) => {
          const matchingTrade = tradeByKey.get(settlement.tradeKey) || null;
          const sourceQueueId =
            matchingTrade?.placed_context?.recoveryQueueId || null;
          const sourceLabel =
            sourceQueueId === row.queueId
              ? "Direct Bet"
              : sourceQueueId
                ? `Spillover from ${sourceQueueId}`
                : "Base Win";
          return {
            tradeKey: settlement.tradeKey,
            eventTitle: settlement.eventTitle,
            competition: settlement.competition,
            settledTime: settlement.settledTime || null,
            pnlUsd: settlement.pnlUsd ?? null,
            allocatedRecoveryUsd: Number(
              (settlement.allocatedRecoveryUsd || 0).toFixed(4),
            ),
            sourceLabel,
          };
        });

        credits.sort((left, right) => {
          const leftTs = this.toTimestamp(left.settledTime) ?? 0;
          const rightTs = this.toTimestamp(right.settledTime) ?? 0;
          return leftTs - rightTs;
        });
        creditsByQueue.set(row.queueId, credits);
      }

      return creditsByQueue;
    },
  );
  readonly sortedRecoveryQueue = computed<RecoveryQueueRow[]>(() => {
    const d = this.data();
    if (!d) return [];
    const attemptsByQueue = this.directRecoveryAttemptMap();
    const latestAttemptFor = (row: RecoveryQueueRow) => {
      const attempts = attemptsByQueue.get(row.queueId) || [];
      return attempts.length ? attempts[attempts.length - 1] : null;
    };
    return this.sortRows(
      d.recovery?.queue || [],
      this.tableSort().recoveryQueue,
      {
        queueId: (row) => row.queueId,
        sourceEventTitle: (row) => row.sourceEventTitle,
        competition: (row) => row.competition,
        lossUsd: (row) => row.lossUsd,
        recoveredUsd: (row) => row.recoveredUsd,
        remainingTargetUsd: (row) => row.remainingTargetUsd,
        recoveryBet: (row) => latestAttemptFor(row)?.eventTitle,
        stakeUsdTarget: (row) =>
          this.recoveryAttemptStakeUsd(latestAttemptFor(row)),
        yesPrice: (row) => latestAttemptFor(row)?.yesPrice,
        recoveryBetResultUsd: (row) => latestAttemptFor(row)?.pnlUsd,
        status: (row) => row.status,
      },
    );
  });
  readonly sortedLeagueLeaderboard = computed<LeagueLeaderboardRow[]>(() => {
    const d = this.data();
    if (!d) return [];
    return this.sortRows(
      d.leagueLeaderboard || [],
      this.tableSort().leagueLeaderboard,
      {
        league: (row) => row.league,
        trades: (row) => row.trades,
        wins: (row) => row.wins,
        losses: (row) => row.losses,
        winRate: (row) => row.winRate,
        avgRoiPct: (row) => row.avgRoiPct,
        totalPnlUsd: (row) => row.totalPnlUsd,
      },
    );
  });
  readonly sortedStrategyLeaderboard = computed<StrategyLeaderboardRow[]>(
    () => {
      const d = this.data();
      if (!d) return [];
      return this.sortRows(
        d.strategyLeaderboard || [],
        this.tableSort().strategyLeaderboard,
        {
          strategy: (row) => row.strategy,
          trades: (row) => row.trades,
          wins: (row) => row.wins,
          losses: (row) => row.losses,
          winRate: (row) => row.winRate,
          avgRoiPct: (row) => row.avgRoiPct,
          totalPnlUsd: (row) => row.totalPnlUsd,
        },
      );
    },
  );
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
      {
        label: "Live Games",
        value: d.monitoredGamesSummary.total,
        format: "num",
      },
      {
        label: "Eligible Now",
        value: d.monitoredGamesSummary.eligibleNow,
        format: "num",
      },
      {
        label: "Already Bet",
        value: d.monitoredGamesSummary.alreadyBet,
        format: "num",
      },
      {
        label: "Open Positions",
        value: d.account.openPositionsCount,
        format: "num",
      },
      { label: "Orders Filled", value: d.metrics.totalFilled, format: "num" },
      { label: "Fill Rate", value: d.metrics.fillRate, format: "pct" },
    ];
  });
  readonly netAccountValue = computed(() => {
    const d = this.data();
    if (!d) return null;
    if (d.account.balanceUsd === null && d.account.portfolioValueUsd === null)
      return null;
    return Number(
      (
        (d.account.balanceUsd ?? 0) + (d.account.portfolioValueUsd ?? 0)
      ).toFixed(2),
    );
  });
  readonly headerMetrics = computed<HeaderMetric[]>(() => {
    const d = this.data();
    if (!d) return [];
    const allTimePnl = this.allTimePnlStats();

    const netAccountValue = this.netAccountValue();
    const totalInvested =
      d.account.investedCapitalUsd === null ||
      d.account.investedCapitalUsd === undefined
        ? null
        : Number(d.account.investedCapitalUsd.toFixed(2));
    const allTimePnlPct =
      totalInvested && totalInvested > 0
        ? allTimePnl.value / totalInvested
        : null;
    const totalBetsPlaced = d.metrics.totalBetsPlaced;

    return [
      {
        label: "Net Account Value",
        value:
          netAccountValue === null ? "-" : `$${netAccountValue.toFixed(2)}`,
        tone: this.numberTone(netAccountValue),
      },
      {
        label: "Available Balance",
        value:
          d.account.balanceUsd === null
            ? "-"
            : `$${Number(d.account.balanceUsd).toFixed(2)}`,
        tone: this.numberTone(d.account.balanceUsd),
      },
      {
        label: "All-Time PnL",
        value:
          allTimePnlPct === null
            ? `${allTimePnl.value >= 0 ? "+" : ""}$${allTimePnl.value.toFixed(2)}`
            : `${allTimePnl.value >= 0 ? "+" : ""}$${allTimePnl.value.toFixed(2)} (${allTimePnlPct >= 0 ? "+" : ""}${(allTimePnlPct * 100).toFixed(2)}%)`,
        tone: this.numberTone(allTimePnl.value),
      },
      {
        label: "Open Position Value",
        value:
          d.account.portfolioValueUsd === null
            ? "-"
            : `$${Number(d.account.portfolioValueUsd).toFixed(2)}`,
        tone: this.numberTone(d.account.portfolioValueUsd),
      },
      {
        label: "Total Amount Invested",
        value: totalInvested === null ? "-" : `$${totalInvested.toFixed(2)}`,
        tone: this.numberTone(totalInvested),
      },
      {
        label: "Total Bets Placed",
        value:
          typeof totalBetsPlaced === "number"
            ? totalBetsPlaced.toLocaleString("en-US")
            : "-",
        tone: this.numberTone(totalBetsPlaced),
      },
    ];
  });

  readonly botPerformanceMetrics = computed<MetricCard[]>(() => {
    const d = this.data();
    if (!d) return [];
    const investedCapital = this.investedCapital();
    const pctOfInvested = (value: number | null) =>
      investedCapital &&
      investedCapital > 0 &&
      value !== null &&
      value !== undefined
        ? value / investedCapital
        : null;
    return [
      {
        label: "Available Balance",
        value: d.account.balanceUsd,
        format: "usd",
      },
      {
        label: "Open Position Value",
        value: d.account.portfolioValueUsd,
        format: "usd",
      },
      {
        label: "Net Account Value",
        value:
          d.account.balanceUsd === null && d.account.portfolioValueUsd === null
            ? null
            : Number(
                (
                  (d.account.balanceUsd ?? 0) +
                  (d.account.portfolioValueUsd ?? 0)
                ).toFixed(2),
              ),
        format: "usd",
      },
      {
        label: "Today PnL",
        value: d.account.pnlTodayUsd,
        format: "usd",
        secondaryPct: pctOfInvested(d.account.pnlTodayUsd),
      },
      {
        label: "Realized PnL",
        value: d.account.pnl14dUsd,
        format: "usd",
        secondaryPct: pctOfInvested(d.account.pnl14dUsd),
      },
      {
        label: "Open ROI PnL",
        value: d.account.openUnrealizedPnlUsd,
        format: "usd",
        secondaryPct: pctOfInvested(d.account.openUnrealizedPnlUsd),
      },
      { label: "Open ROI %", value: d.account.openRoiPct, format: "pct" },
    ];
  });

  readonly tradePerformanceMetrics = computed<MetricCard[]>(() => {
    const d = this.data();
    if (!d) return [];
    return [
      { label: "Win Rate", value: d.analytics.winRate, format: "pct" },
      {
        label: "Avg Winner ROI",
        value: d.analytics.avgWinnerRoiPct,
        format: "pct",
      },
      {
        label: "Avg $ ROI / Win",
        value: d.analytics.avgWinRoiUsd,
        format: "usd",
      },
      {
        label: "Avg PnL Per Trade",
        value: d.analytics.expectancyPerTradeUsd,
        format: "usd",
      },
      {
        label: "Avg Loss (Abs)",
        value: d.analytics.avgLossAbsUsd,
        format: "usd",
      },
      {
        label: "Breakeven Win Rate",
        value: d.analytics.breakevenWinRate,
        format: "pct",
      },
      {
        label: "Max Drawdown",
        value: d.analytics.maxDrawdownUsd,
        format: "usd",
      },
      {
        label: "Longest Win Streak",
        value: d.analytics.longestWinStreak,
        format: "num",
      },
      {
        label: "Longest Loss Streak",
        value: d.analytics.longestLossStreak,
        format: "num",
      },
    ];
  });

  readonly riskMetrics = computed<MetricCard[]>(() => {
    const d = this.data();
    if (!d) return [];
    const netAccountValue =
      (d.account.balanceUsd ?? 0) + (d.account.portfolioValueUsd ?? 0);
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
      netAccountValue > 0 &&
      d.config.maxDailyLossUsd !== null &&
      d.config.maxDailyLossUsd !== undefined
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
      d.analytics.avgLossAbsUsd &&
      d.analytics.avgLossAbsUsd > 0 &&
      (d.account.balanceUsd ?? 0) > 0
        ? Math.floor((d.account.balanceUsd ?? 0) / d.analytics.avgLossAbsUsd)
        : null;

    return [
      { label: "Edge Gap", value: edgeGap, format: "pct" },
      { label: "Loss / Win Ratio", value: avgLossToWin, format: "num" },
      { label: "Avg Bet % Bankroll", value: avgBetPct, format: "pct" },
      { label: "Max Drawdown %", value: maxDrawdownPct, format: "pct" },
      { label: "Stop-Loss % Bankroll", value: stopLossPct, format: "pct" },
      { label: "Recovery Queue %", value: recoveryQueuePct, format: "pct" },
      { label: "Avg Losses To Stop", value: lossesToStop, format: "num" },
      {
        label: "Avg Losses To Bankrupt",
        value: lossesToBankrupt,
        format: "num",
      },
    ];
  });

  readonly riskStatus = computed(() => {
    const d = this.data();
    if (!d) {
      return {
        edge: "Unknown",
        ruinRisk: "Unknown",
        note: "No dashboard data loaded",
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
        edge: "Negative",
        ruinRisk: "High",
        note: "Current win rate is below breakeven for the current payoff profile.",
      };
    }

    if (queueBurden > balance * 0.15) {
      return {
        edge: "Thin",
        ruinRisk: "Elevated",
        note: "Recovery burden is large relative to available balance.",
      };
    }

    return {
      edge: "Positive",
      ruinRisk: "Controlled",
      note: "Sustainability still depends on keeping stake size small relative to bankroll.",
    };
  });

  readonly recoveryMetrics = computed<MetricCard[]>(() => {
    const d = this.data();
    if (!d) return [];
    return [
      {
        label: "Next Recovery Target",
        value: d.recovery?.nextTargetProfitUsd ?? 0,
        format: "usd",
      },
      {
        label: "Unresolved Losses",
        value: d.recovery?.unresolvedLossCount ?? 0,
        format: "num",
      },
      {
        label: "Loss Streak",
        value: d.recovery?.currentLossStreak ?? d.bot.recoveryLossStreak ?? 0,
        format: "num",
      },
      {
        label: "Recovery Loss $",
        value:
          d.recovery?.recoveryLossBalanceUsd ??
          d.bot.recoveryLossBalanceUsd ??
          0,
        format: "usd",
      },
      {
        label: "Wins / Single Loss",
        value: d.analytics.winsRequiredToRecoverSingleLoss,
        format: "num",
      },
      {
        label: "Wins To Breakeven",
        value: d.analytics.winsRequiredToBreakeven,
        format: "num",
      },
      {
        label: "Base Stake",
        value: d.recovery?.baseStakeUsd ?? d.config.stakeUsd ?? null,
        format: "usd",
      },
    ];
  });

  readonly pnlSeries = computed(() => {
    const d = this.data();
    if (!d) return [] as PnlPoint[];

    const sorted = [...(d.closedTrades || [])].sort(
      (a, b) =>
        new Date(a.settled_time).getTime() - new Date(b.settled_time).getTime(),
    );

    const points: PnlPoint[] = [];
    let cumulative = 0;
    const firstSettledTs = sorted.length
      ? new Date(sorted[0].settled_time).getTime()
      : null;

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
    const withOpen = Number(
      (cumulative + Number(d.account.openUnrealizedPnlUsd || 0)).toFixed(4),
    );
    points.push({ ts: nowTs, pnl: withOpen });

    return points.length ? points : [{ ts: nowTs, pnl: 0 }];
  });
  readonly allTimePnlStats = computed(() => {
    const points = this.pnlSeries();
    const value = points[points.length - 1]?.pnl ?? 0;
    const investedCapital = this.investedCapital();
    return {
      value,
      pct:
        investedCapital && investedCapital > 0 ? value / investedCapital : null,
    };
  });
  readonly investedCapital = computed(() => {
    const d = this.data();
    if (!d) return null;
    const investedCapitalUsd = d.account.investedCapitalUsd;
    return investedCapitalUsd !== null &&
      investedCapitalUsd !== undefined &&
      investedCapitalUsd > 0
      ? Number(investedCapitalUsd.toFixed(4))
      : null;
  });

  readonly rangeFilteredSeries = computed(() => {
    const series = this.pnlSeries();
    if (!series.length) return series;
    const range = this.chartRange();
    if (range === "ALL") return series;

    const nowTs = this.now().getTime();
    let fromTs = 0;

    if (range === "LIVE") {
      const start = new Date(nowTs);
      start.setHours(0, 0, 0, 0);
      fromTs = start.getTime();
    }
    if (range === "1H") fromTs = nowTs - 1 * 60 * 60 * 1000;
    if (range === "3H") fromTs = nowTs - 3 * 60 * 60 * 1000;
    if (range === "6H") fromTs = nowTs - 6 * 60 * 60 * 1000;
    if (range === "12H") fromTs = nowTs - 12 * 60 * 60 * 1000;
    if (range === "1D") fromTs = nowTs - 24 * 60 * 60 * 1000;
    if (range === "1W") fromTs = nowTs - 7 * 24 * 60 * 60 * 1000;
    if (range === "1M") fromTs = nowTs - 30 * 24 * 60 * 60 * 1000;
    if (range === "3M") fromTs = nowTs - 90 * 24 * 60 * 60 * 1000;
    if (range === "6M") fromTs = nowTs - 182 * 24 * 60 * 60 * 1000;
    if (range === "1Y") fromTs = nowTs - 365 * 24 * 60 * 60 * 1000;
    if (range === "3Y") fromTs = nowTs - 3 * 365 * 24 * 60 * 60 * 1000;
    if (range === "5Y") fromTs = nowTs - 5 * 365 * 24 * 60 * 60 * 1000;
    if (range === "YTD") {
      const d = new Date(nowTs);
      fromTs = new Date(d.getFullYear(), 0, 1).getTime();
    }

    const filtered = series.filter((p) => p.ts >= fromTs);
    if (!filtered.length) {
      const last = series[Math.max(0, series.length - 1)];
      return [
        { ts: fromTs, pnl: last.pnl },
        { ts: nowTs, pnl: last.pnl },
      ];
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
    const currentPoint =
      selectedPoints[selectedPoints.length - 1] ||
      hovered ||
      points[points.length - 1] ||
      null;
    const startPoint =
      comparisonPoints.length >= 2 ? comparisonPoints[0] : points[0] || null;
    const endPoint =
      comparisonPoints.length >= 2 ? comparisonPoints[1] : currentPoint;
    const currentValue = currentPoint?.pnl ?? last;
    const currentPct =
      investedCapital && investedCapital > 0
        ? currentValue / investedCapital
        : null;
    const delta = Number(
      ((endPoint?.pnl ?? currentValue) - (startPoint?.pnl ?? 0)).toFixed(4),
    );
    const deltaPct =
      investedCapital && investedCapital > 0 ? delta / investedCapital : null;

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
    return Number(
      (
        currentNetAccountValue -
        allTimePnl +
        this.chartStats().currentValue
      ).toFixed(2),
    );
  });
  readonly authConfigured = computed(() => isSupabaseBrowserAuthConfigured());
  readonly showAuthScreen = computed(
    () => this.authConfigured() && !this.authLoading() && !this.session(),
  );
  readonly canShowDashboardContent = computed(
    () => !this.authConfigured() || Boolean(this.session()),
  );
  readonly credentialStorageConfigured = computed(
    () => this.credentialStatus()?.configured ?? false,
  );
  readonly hasStoredCredential = computed(
    () => this.credentialStatus()?.hasCredential ?? false,
  );
  readonly canSaveCredential = computed(() =>
    Boolean(
      (this.credentialStorageConfigured() || this.credentialStatusError()) &&
      this.credentialApiKeyId().trim() &&
      this.credentialPem().trim() &&
      this.credentialPemFileName().trim(),
    ),
  );
  readonly credentialBanner = computed<CredentialBannerState | null>(() => {
    if (!this.session()) return null;

    if (this.credentialStatusError()) {
      return {
        tone: "attention",
        title:
          this.credentialStatusError() || "Kalshi credentials need attention.",
        subtitle:
          "Use the key icon in the top-right header to open Kalshi credentials.",
      };
    }

    if (this.credentialStorageConfigured() && !this.hasStoredCredential()) {
      return {
        tone: "setup",
        title: "Add your Kalshi credentials to unlock account data.",
        subtitle:
          "Use the key icon in the top-right header to upload your API key ID and PEM file.",
      };
    }

    return null;
  });
  readonly credentialHealthLabel = computed(() => {
    switch (this.credentialHealthState()) {
      case "checking":
        return "Checking...";
      case "healthy":
        return "Connected";
      case "failed":
        return "Failed";
      default:
        return "Not Checked";
    }
  });
  readonly credentialHealthClass = computed(() => {
    switch (this.credentialHealthState()) {
      case "checking":
        return "status-info";
      case "healthy":
        return "status-good";
      case "failed":
        return "status-bad";
      default:
        return "status-neutral";
    }
  });
  readonly credentialHealthEndpointLabel =
    "Kalshi endpoint: GET /portfolio/balance";
  readonly canFetchDashboard = computed(() => {
    const runtime = getDashboardRuntimeConfig();
    if (runtime.apiToken) return true;
    if (!this.authConfigured()) return true;
    return Boolean(this.session()?.access_token);
  });
  readonly authUserLabel = computed(
    () => this.user()?.email || this.user()?.id || "Authenticated user",
  );
  readonly dashboardLoadingStage = computed<"connect" | "account" | "market">(
    () => {
      const elapsed = this.dashboardLoadingElapsedSeconds();
      if (elapsed >= 9) return "market";
      if (elapsed >= 4) return "account";
      return "connect";
    },
  );
  readonly dashboardLoadingTitle = computed(() => {
    const stage = this.dashboardLoadingStage();
    if (stage === "connect") return "Connecting to your trading workspace";
    if (stage === "account")
      return "Loading balances, positions, and settlements";
    return "Preparing the live market view";
  });
  readonly dashboardLoadingSubtitle = computed(() => {
    const stage = this.dashboardLoadingStage();
    if (stage === "connect") {
      return "The first dashboard sync starts right after sign-in and waits for a fresh backend response.";
    }
    if (stage === "account") {
      return "We are pulling your latest Kalshi account state before rendering the dashboard.";
    }
    return "Live market context and recent activity are being stitched into the dashboard now.";
  });
  readonly dashboardLoadingProgress = computed(() =>
    Math.min(94, 22 + this.dashboardLoadingElapsedSeconds() * 9),
  );
  readonly dashboardLoadingSteps = computed(() => {
    const stage = this.dashboardLoadingStage();
    return [
      {
        label: "Secure session check",
        detail:
          "Verifying the current session and opening the dashboard request.",
        status: stage === "connect" ? "active" : "complete",
      },
      {
        label: "Kalshi account sync",
        detail: "Fetching fresh balances, positions, and recent settlements.",
        status:
          stage === "account"
            ? "active"
            : stage === "market"
              ? "complete"
              : "pending",
      },
      {
        label: "Market context build",
        detail: "Loading live market data and assembling the trading view.",
        status: stage === "market" ? "active" : "pending",
      },
    ];
  });
  readonly dashboardLoadingHint = computed(() => {
    if (this.dashboardLoadingElapsedSeconds() < 8)
      return "This only affects the first sync after login.";
    return "This first load can take longer because the dashboard waits for fresh account and market data together.";
  });
  readonly dashboardLoadingElapsedLabel = computed(() => {
    const elapsed = this.dashboardLoadingElapsedSeconds();
    if (elapsed < 60) return `${Math.max(1, elapsed)}s elapsed`;
    const minutes = Math.floor(elapsed / 60);
    const seconds = elapsed % 60;
    return `${minutes}m ${seconds}s elapsed`;
  });
  readonly runtimeMode = computed<RuntimeMode>(() => {
    const pending = this.runtimeModePending();
    if (pending) return pending;
    const d = this.data();
    return d?.config?.dryRun ? "paper" : "live";
  });
  readonly displayedAgentStatusClass = computed(() => {
    if (this.runtimeModeBusy()) return "status-info";
    return this.statusClass(this.data()?.bot.status);
  });
  readonly displayedAgentStatusLabel = computed(() => {
    if (this.runtimeModeBusy()) return "Updating Mode";
    return this.agentStatusLabel(this.data()?.bot.status);
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
      document.documentElement.setAttribute("data-theme", theme);
      document.body.setAttribute("data-theme", theme);
    });

    void this.initializeAuth();
    this.startRefreshLoop();
  }

  ngAfterViewInit(): void {
    this.chartViewReady.set(true);
    this.renderChart();
  }

  ngOnDestroy(): void {
    this.authSubscription?.unsubscribe();
    this.unsubscribeDashboardSnapshot();
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    if (this.credentialHealthTimer) clearTimeout(this.credentialHealthTimer);
    if (this.dashboardLoadingTimer) clearInterval(this.dashboardLoadingTimer);
    if (this.runtimeModeSyncTimer) clearTimeout(this.runtimeModeSyncTimer);
    if (this.chartInstance) {
      this.chartInstance.destroy();
      this.chartInstance = null;
    }
  }

  async signIn(): Promise<void> {
    if (!this.supabase) {
      this.authError.set(
        "Supabase auth is not configured. Add SUPABASE_URL and SUPABASE_PUBLISHABLE_KEY.",
      );
      return;
    }

    this.authLoading.set(true);
    this.authError.set(null);
    this.authMessage.set(null);

    const { error } = await this.supabase.auth.signInWithPassword({
      email: this.authEmail().trim(),
      password: this.authPassword(),
    });

    this.authLoading.set(false);

    if (error) {
      this.authError.set(error.message);
      return;
    }

    this.authPassword.set("");
  }

  async signUp(): Promise<void> {
    if (!this.supabase) {
      this.authError.set(
        "Supabase auth is not configured. Add SUPABASE_URL and SUPABASE_PUBLISHABLE_KEY.",
      );
      return;
    }

    if (!this.isSignupPasswordValid()) {
      this.authError.set("Use a stronger password to create your account.");
      this.authMessage.set(null);
      return;
    }

    if (!this.passwordsMatch()) {
      this.authError.set("Passwords must match to create your account.");
      this.authMessage.set(null);
      return;
    }

    this.authLoading.set(true);
    this.authError.set(null);
    this.authMessage.set(null);

    const { error } = await this.supabase.auth.signUp({
      email: this.authEmail().trim(),
      password: this.authPassword(),
      options: {
        emailRedirectTo: window.location.origin,
      },
    });

    this.authLoading.set(false);

    if (error) {
      this.authError.set(error.message);
      return;
    }

    this.authMessage.set(
      "Sign-up succeeded. Check your email if confirmation is enabled, then log in.",
    );
    this.authMode.set("login");
    this.authPassword.set("");
    this.authConfirmPassword.set("");
  }

  async signOut(): Promise<void> {
    if (!this.supabase) return;

    this.authLoading.set(true);
    this.authError.set(null);
    this.authMessage.set(null);

    const { error } = await this.supabase.auth.signOut();
    this.authLoading.set(false);

    if (error) {
      this.authError.set(error.message);
      return;
    }

    this.applySession(null, "SIGNED_OUT");
  }

  updateAuthField(
    field: "email" | "password" | "confirmPassword",
    value: string,
  ): void {
    if (field === "email") {
      this.authEmail.set(value);
      return;
    }

    if (field === "confirmPassword") {
      this.authConfirmPassword.set(value);
      return;
    }

    this.authPassword.set(value);
  }

  setAuthMode(mode: "login" | "signup"): void {
    this.authMode.set(mode);
    this.showPassword.set(false);
    this.authError.set(null);
    this.authMessage.set(null);
    this.authPassword.set("");
    this.authConfirmPassword.set("");
  }

  togglePasswordVisibility(): void {
    this.showPassword.update((current) => !current);
  }

  toggleUserMenu(event?: Event): void {
    event?.stopPropagation();
    this.userMenuOpen.update((current) => !current);
    this.credentialMenuOpen.set(false);
  }

  closeUserMenu(): void {
    this.userMenuOpen.set(false);
  }

  toggleCredentialMenu(event?: Event): void {
    event?.stopPropagation();
    this.credentialMenuOpen.update((current) => !current);
    this.userMenuOpen.set(false);
    this.credentialDeleteConfirm.set(false);
    this.credentialHealthInfoOpen.set(false);
  }

  closeCredentialMenu(): void {
    this.credentialMenuOpen.set(false);
    this.credentialHealthInfoOpen.set(false);
  }

  updateCredentialField(field: "apiKeyId" | "pem", value: string): void {
    if (field === "apiKeyId") {
      this.credentialApiKeyId.set(value);
      if (this.credentialPem().trim() && this.credentialPemFileName().trim()) {
        this.scheduleDraftCredentialHealthCheck();
      } else if (this.hasStoredCredential() && !this.credentialReplaceMode()) {
        this.scheduleStoredCredentialHealthCheck(0);
      }
      return;
    }

    this.credentialPem.set(value);
    if (this.hasStoredCredential() && !this.credentialReplaceMode()) {
      this.scheduleStoredCredentialHealthCheck(0);
    }
  }

  beginDeleteCredential(): void {
    this.credentialDeleteConfirm.set(true);
    this.credentialsError.set(null);
    this.credentialsMessage.set(null);
    this.credentialHealthInfoOpen.set(false);
  }

  cancelDeleteCredential(): void {
    this.credentialDeleteConfirm.set(false);
  }

  beginReplaceCredential(): void {
    this.credentialReplaceMode.set(true);
    this.credentialDeleteConfirm.set(false);
    this.credentialsError.set(null);
    this.credentialsMessage.set(null);
    this.credentialHealthInfoOpen.set(false);
  }

  cancelReplaceCredential(): void {
    this.credentialReplaceMode.set(false);
    this.credentialApiKeyId.set("");
    this.credentialPem.set("");
    this.credentialPemFileName.set("");
    this.credentialsError.set(null);
    this.credentialsMessage.set(null);
    this.credentialHealthInfoOpen.set(false);
    this.scheduleStoredCredentialHealthCheck(0);
  }

  toggleCredentialHealthInfo(event?: Event): void {
    event?.stopPropagation();
    this.credentialHealthInfoOpen.update((current) => !current);
  }

  async handlePemFileSelected(event: Event): Promise<void> {
    const input = event.target as HTMLInputElement | null;
    const file = input?.files?.[0];
    if (!file) return;

    try {
      const pemText = await file.text();
      this.credentialPem.set(pemText);
      this.credentialPemFileName.set(file.name);
      this.credentialReplaceMode.set(this.hasStoredCredential());
      this.credentialsError.set(null);
      this.credentialsMessage.set(
        `Loaded ${file.name}. Save to encrypt and store it on the server.`,
      );
      this.scheduleDraftCredentialHealthCheck(0);
    } catch {
      this.credentialsError.set("Failed to read the selected PEM file.");
      this.resetCredentialHealthCheck(
        "failed",
        "Kalshi API health check could not start because the PEM file could not be read.",
      );
    } finally {
      if (input) input.value = "";
    }
  }

  saveCredential(): void {
    const headers = this.getAuthHeaders();
    if (!headers) {
      this.credentialsError.set("Sign in before saving Kalshi credentials.");
      return;
    }

    this.credentialsSaving.set(true);
    this.credentialsError.set(null);
    this.credentialsMessage.set(null);

    this.http
      .post<{ ok: boolean; message?: string; credentials?: CredentialStatus }>(
        buildApiUrl("/api/credentials"),
        {
          kalshiApiKeyId: this.credentialApiKeyId().trim(),
          privateKeyPem: this.credentialPem(),
          pemFileName: this.credentialPemFileName(),
        },
        { headers },
      )
      .subscribe({
        next: (response) => {
          const priorHealthState = this.credentialHealthState();
          this.credentialsSaving.set(false);
          this.credentialStatus.set(response.credentials || null);
          this.credentialApiKeyId.set("");
          this.credentialPem.set("");
          this.credentialPemFileName.set("");
          this.credentialReplaceMode.set(false);
          if (priorHealthState === "healthy") {
            this.credentialHealthState.set("healthy");
            this.credentialHealthMessage.set(
              "Stored Kalshi credentials verified successfully.",
            );
          } else {
            this.scheduleStoredCredentialHealthCheck(0);
          }
          this.credentialDeleteConfirm.set(false);
          this.credentialsMessage.set(
            response.message || "Kalshi credential saved securely.",
          );
          this.fetchDashboard();
        },
        error: (err) => {
          this.credentialsSaving.set(false);
          this.credentialsError.set(
            this.describeCredentialError(
              err,
              "Failed to save Kalshi credential",
            ),
          );
        },
      });
  }

  deleteCredential(): void {
    const headers = this.getAuthHeaders();
    if (!headers) {
      this.credentialsError.set("Sign in before deleting Kalshi credentials.");
      return;
    }

    this.credentialsSaving.set(true);
    this.credentialsError.set(null);
    this.credentialsMessage.set(null);

    this.http
      .delete<{
        ok: boolean;
        message?: string;
        credentials?: CredentialStatus;
      }>(buildApiUrl("/api/credentials"), { headers })
      .subscribe({
        next: (response) => {
          this.credentialsSaving.set(false);
          this.credentialStatus.set(response.credentials || null);
          this.credentialApiKeyId.set("");
          this.credentialPem.set("");
          this.credentialPemFileName.set("");
          this.credentialReplaceMode.set(false);
          this.resetCredentialHealthCheck();
          this.credentialDeleteConfirm.set(false);
          this.credentialsMessage.set(
            response.message || "Kalshi credential removed.",
          );
          this.fetchDashboard();
        },
        error: (err) => {
          this.credentialsSaving.set(false);
          this.credentialsError.set(
            this.describeCredentialError(
              err,
              "Failed to delete Kalshi credential",
            ),
          );
        },
      });
  }

  private async initializeAuth(): Promise<void> {
    if (!this.supabase) {
      this.authLoading.set(false);
      this.startDashboardLoading();
      this.fetchDashboard();
      return;
    }

    const {
      data: { session },
      error,
    } = await this.supabase.auth.getSession();

    if (error) {
      this.authError.set(error.message);
    }

    this.applySession(session, "INITIAL_SESSION");

    const subscription = this.supabase.auth.onAuthStateChange(
      (event: AuthChangeEvent, nextSession: Session | null) => {
        this.applySession(nextSession, event);
      },
    );
    this.authSubscription = subscription.data.subscription;
  }

  private applySession(
    session: Session | null,
    event: AuthChangeEvent | "INITIAL_SESSION",
  ): void {
    const previousSession = this.session();
    const previousUserId = previousSession?.user?.id || null;
    const nextUserId = session?.user?.id || null;
    const userChanged = previousUserId !== nextUserId;
    const sessionPresenceChanged = Boolean(previousSession) !== Boolean(session);

    if (userChanged || sessionPresenceChanged) {
      this.dashboardRequestId += 1;
    }

    if (userChanged && this.dashboardSnapshotChannel) {
      this.unsubscribeDashboardSnapshot();
    }

    this.session.set(session);
    this.user.set(session?.user ?? null);
    this.userMenuOpen.set(false);
    this.credentialMenuOpen.set(false);
    this.authLoading.set(false);
    this.credentialsError.set(null);
    this.credentialsMessage.set(null);
    this.credentialStatusError.set(null);

    if (!session && this.authConfigured()) {
      this.unsubscribeDashboardSnapshot();
      this.data.set(null);
      this.credentialStatus.set(null);
      this.credentialApiKeyId.set("");
      this.credentialPem.set("");
      this.credentialPemFileName.set("");
      this.credentialReplaceMode.set(false);
      this.resetCredentialHealthCheck();
      this.credentialDeleteConfirm.set(false);
      this.dashboardRefreshQueued = false;
      this.stopDashboardLoading();
      this.error.set(null);
      return;
    }

    if (session) {
      if (
        userChanged ||
        event === "INITIAL_SESSION" ||
        event === "SIGNED_IN" ||
        !this.credentialStatus()
      ) {
        this.fetchCredentialStatus();
      }

      if (
        userChanged ||
        !this.dashboardSnapshotChannel ||
        this.dashboardSnapshotUserId !== session.user.id
      ) {
        this.subscribeDashboardSnapshot(session.user.id);
      }
    }

    const shouldShowInitialLoading =
      !this.data() ||
      userChanged ||
      event === "INITIAL_SESSION" ||
      event === "SIGNED_IN";
    if (shouldShowInitialLoading) {
      this.startDashboardLoading();
      void this.loadDashboardSnapshotOrApi();
    }
  }

  private startRefreshLoop(): void {
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    this.refreshTimer = setInterval(() => {
      this.now.set(new Date());
      if (!this.shouldUseRealtimeDashboard()) {
        this.fetchDashboard();
      }
    }, 5000);
  }

  private loadTheme(): ThemeMode {
    try {
      const stored = localStorage.getItem("dashboardTheme");
      if (stored === "light" || stored === "dark") return stored;
    } catch {
      // Ignore storage errors and fallback to light mode.
    }
    return "light";
  }

  toggleTheme(): void {
    const next: ThemeMode = this.theme() === "light" ? "dark" : "light";
    this.theme.set(next);
    try {
      localStorage.setItem("dashboardTheme", next);
    } catch {
      // Ignore storage write errors.
    }
  }

  openSettings(): void {
    this.resetRuntimeSettingsDraft();
    this.settingsOpen.set(true);
  }

  closeSettings(): void {
    this.settingsOpen.set(false);
    this.resetRuntimeSettingsDraft();
  }

  setChartRange(range: ChartRange): void {
    this.chartRange.set(range);
    this.hoveredPoint.set(null);
    this.selectedChartPoints.set([]);
  }

  @HostListener("document:click", ["$event"])
  onDocumentClick(event: MouseEvent): void {
    this.closeCredentialMenu();
    this.closeUserMenu();
    const target = event.target as Node | null;
    const chartWrapEl = this.chartWrap?.nativeElement;
    if (!target || !chartWrapEl) return;
    if (chartWrapEl.contains(target)) return;
    if (this.selectedChartPoints().length) {
      this.selectedChartPoints.set([]);
      this.hoveredPoint.set(null);
    }
  }

  @HostListener("document:keydown.escape")
  onEscapeKey(): void {
    if (this.settingsOpen()) {
      this.closeSettings();
    }
  }

  setLogViewMode(mode: LogViewMode): void {
    this.logViewMode.set(mode);
  }

  setLogTimeRange(range: LogTimeRange): void {
    this.logTimeRange.set(range);
  }

  private canUseRelativeApiUrl(): boolean {
    const host = window.location.hostname;
    return host === "localhost" || host === "127.0.0.1";
  }

  private logDashboardRealtime(message: string, details?: unknown): void {
    if (details === undefined) {
      console.info(`[dashboard-realtime] ${message}`);
      return;
    }

    console.info(`[dashboard-realtime] ${message}`, details);
  }

  private shouldUseRealtimeDashboard(): boolean {
    return Boolean(this.supabase && this.session()?.user?.id);
  }

  private applyDashboardPayload(payload: DashboardPayload): void {
    const pendingMode = this.runtimeModePending();
    const payloadMode: RuntimeMode = payload?.config?.dryRun ? "paper" : "live";
    const hasFreshBotStatus =
      payload?.bot?.status &&
      payload.bot.status !== "DOWN" &&
      payload.bot.status !== "STARTING";

    if (pendingMode && payloadMode !== pendingMode) {
      this.logDashboardRealtime(
        "Ignoring dashboard payload with stale runtime mode during mode transition",
        {
          pendingMode,
          payloadMode,
          generatedAt: payload?.generatedAt || null,
        },
      );
      return;
    }

    if (!this.sizingDirty() && !this.sizingBusy()) {
      this.syncRuntimeSizingInputs(
        payload?.config?.stakeUsd,
        payload?.config?.recoveryMaxStakeUsd,
        payload?.config?.maxDailyLossUsd,
      );
    }

    if (pendingMode && payloadMode === pendingMode && hasFreshBotStatus) {
      this.runtimeModePending.set(null);
      this.runtimeModeBusy.set(false);
      if (this.runtimeModeSyncTimer) {
        clearTimeout(this.runtimeModeSyncTimer);
        this.runtimeModeSyncTimer = null;
      }
    }
    this.data.set(payload);
    queueMicrotask(() => this.renderChart());
    this.stopDashboardLoading();
    this.error.set(null);
  }

  private async loadDashboardSnapshot(): Promise<boolean> {
    if (!this.supabase || !this.session()?.user?.id) return false;

    try {
      const { data, error } = await this.supabase
        .from("dashboard_snapshots")
        .select("payload")
        .eq("user_id", this.session()!.user.id)
        .maybeSingle<DashboardSnapshotRecord>();

      if (error || !data?.payload) {
        this.logDashboardRealtime("No Supabase snapshot available yet", {
          userId: this.session()!.user.id,
          hasError: Boolean(error),
        });
        return false;
      }

      if (!this.canFetchDashboard()) {
        this.logDashboardRealtime(
          "Snapshot was loaded but dashboard fetch conditions no longer allow apply",
        );
        return false;
      }

      this.logDashboardRealtime("Loaded dashboard from Supabase snapshot", {
        userId: this.session()!.user.id,
        generatedAt: data.payload.generatedAt,
      });
      this.applyDashboardPayload(data.payload);
      return true;
    } catch {
      this.logDashboardRealtime(
        "Snapshot bootstrap failed, falling back to /api/dashboard",
      );
      return false;
    }
  }

  private async loadDashboardSnapshotOrApi(): Promise<void> {
    if (this.shouldUseRealtimeDashboard()) {
      const loadedSnapshot = await this.loadDashboardSnapshot();
      if (loadedSnapshot) return;
    }

    this.logDashboardRealtime("Falling back to /api/dashboard fetch");
    this.fetchDashboard();
  }

  private subscribeDashboardSnapshot(userId: string): void {
    if (!this.supabase) return;

    if (
      this.dashboardSnapshotChannel &&
      this.dashboardSnapshotUserId === userId
    ) {
      this.logDashboardRealtime(
        "Realtime channel already active for current user",
        { userId },
      );
      return;
    }

    this.logDashboardRealtime("Subscribing to dashboard snapshot channel", {
      userId,
    });

    this.dashboardSnapshotUserId = userId;
    this.dashboardSnapshotChannel = this.supabase
      .channel(`dashboard-snapshot:${userId}`)
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "dashboard_snapshots",
          filter: `user_id=eq.${userId}`,
        },
        (eventPayload) => {
          if (!this.canFetchDashboard()) return;

          if (eventPayload.eventType === "DELETE") {
            this.logDashboardRealtime(
              "Snapshot row deleted, reloading via /api/dashboard",
            );
            queueMicrotask(() => this.fetchDashboard());
            return;
          }

          const payload = (
            eventPayload.new as { payload?: DashboardPayload } | null
          )?.payload;

          if (payload) {
            this.logDashboardRealtime("Received Realtime dashboard snapshot", {
              eventType: eventPayload.eventType,
              generatedAt: payload.generatedAt,
            });
            this.applyDashboardPayload(payload);
          }
        },
      )
      .subscribe((status) => {
        this.logDashboardRealtime("Realtime channel status changed", {
          userId,
          status,
        });
      });
  }

  private unsubscribeDashboardSnapshot(): void {
    if (!this.dashboardSnapshotChannel || !this.supabase) return;
    this.logDashboardRealtime("Unsubscribing from dashboard snapshot channel");
    void this.supabase.removeChannel(this.dashboardSnapshotChannel);
    this.dashboardSnapshotChannel = null;
    this.dashboardSnapshotUserId = null;
  }

  private formatDashboardLoadError(
    err: unknown,
    runtimeApiBaseUrl: string,
  ): string {
    if (!runtimeApiBaseUrl && !this.canUseRelativeApiUrl()) {
      return "Dashboard API is not configured for this deployment. Set DASHBOARD_API_BASE_URL to your monitor API base URL.";
    }

    if (err instanceof HttpErrorResponse) {
      if (
        typeof err.error === "string" &&
        err.error.includes("<!doctype html")
      ) {
        return "Dashboard API returned HTML instead of JSON. Verify DASHBOARD_API_BASE_URL or your Netlify /api routing.";
      }
      if (typeof err.message === "string" && err.message.trim())
        return err.message;
    }

    const fallback = (err as { message?: string } | null | undefined)?.message;
    return fallback || "Failed to load dashboard data";
  }

  toggleRiskHalt(active: boolean): void {
    if (this.riskHaltBusy()) return;
    const headers = this.getAuthHeaders();
    if (!headers) {
      this.error.set("Supabase sign-in required");
      return;
    }
    this.riskHaltBusy.set(true);
    this.http
      .post(buildApiUrl("/api/runtime/risk-halt"), { active }, { headers })
      .subscribe({
        next: () => {
          this.riskHaltBusy.set(false);
          this.fetchDashboard();
        },
        error: (err) => {
          this.riskHaltBusy.set(false);
          const message =
            err?.error?.message ||
            err?.message ||
            "Failed to update risk halt override";
          if (this.settingsOpen()) {
            this.sizingError.set(message);
          } else {
            this.error.set(message);
          }
        },
      });
  }

  updateRuntimeStakeInput(value: string): void {
    this.runtimeStakeInput.set(value);
    this.sizingDirty.set(true);
    this.sizingError.set(null);
  }

  updateRuntimeRecoveryMaxInput(value: string): void {
    this.runtimeRecoveryMaxInput.set(value);
    this.sizingDirty.set(true);
    this.sizingError.set(null);
  }

  updateRuntimeMaxDailyLossInput(value: string): void {
    this.runtimeMaxDailyLossInput.set(value);
    this.sizingDirty.set(true);
    this.sizingError.set(null);
  }

  updateRuntimeMode(value: string): void {
    const mode: RuntimeMode = value === "live" ? "live" : "paper";
    if (this.runtimeModeBusy()) return;
    if (mode === this.runtimeMode()) return;

    const headers = this.getAuthHeaders();
    if (!headers) {
      this.sizingError.set("Supabase sign-in required");
      return;
    }

    this.runtimeModeBusy.set(true);
    this.runtimeModePending.set(mode);
    this.sizingError.set(null);
    if (this.runtimeModeSyncTimer) {
      clearTimeout(this.runtimeModeSyncTimer);
    }
    this.runtimeModeSyncTimer = setTimeout(() => {
      this.runtimeModeSyncTimer = null;
      this.runtimeModeBusy.set(false);
      this.runtimeModePending.set(null);
      this.sizingError.set(
        "Mode change was sent, but the refreshed dashboard state did not arrive in time.",
      );
    }, 15000);

    this.http
      .post<RuntimeModeResponse>(
        buildApiUrl("/api/runtime/mode"),
        { mode },
        { headers },
      )
      .subscribe({
        next: () => {
          this.fetchDashboard();
        },
        error: (err) => {
          if (this.runtimeModeSyncTimer) {
            clearTimeout(this.runtimeModeSyncTimer);
            this.runtimeModeSyncTimer = null;
          }
          this.runtimeModeBusy.set(false);
          this.runtimeModePending.set(null);
          this.sizingError.set(
            err?.error?.message || err?.message || "Failed to update mode",
          );
        },
      });
  }

  saveRuntimeSizing(
    stakeUsd = this.runtimeSizingValidation().baseStakeUsd,
    recoveryMaxStakeUsd = this.runtimeSizingValidation().recoveryMaxStakeUsd,
    maxDailyLossUsd = this.runtimeSizingValidation().maxDailyLossUsd,
  ): void {
    if (this.sizingBusy()) return;
    if (
      !Number.isFinite(Number(stakeUsd)) ||
      !Number.isFinite(Number(recoveryMaxStakeUsd)) ||
      !Number.isFinite(Number(maxDailyLossUsd))
    ) {
      this.sizingError.set(
        this.runtimeSizingValidation().message ||
          "Enter valid runtime control values.",
      );
      return;
    }

    const validation = this.runtimeSizingValidation();
    if (
      !validation.valid &&
      stakeUsd === validation.baseStakeUsd &&
      recoveryMaxStakeUsd === validation.recoveryMaxStakeUsd &&
      maxDailyLossUsd === validation.maxDailyLossUsd
    ) {
      this.sizingError.set(
        validation.message || "Runtime control values are invalid.",
      );
      return;
    }

    const headers = this.getAuthHeaders();
    if (!headers) {
      this.sizingError.set("Supabase sign-in required");
      return;
    }
    this.sizingBusy.set(true);
    this.sizingError.set(null);

    this.http
      .post<RuntimeSizingResponse>(
        buildApiUrl("/api/runtime/sizing"),
        { stakeUsd, recoveryMaxStakeUsd, maxDailyLossUsd },
        { headers },
      )
      .subscribe({
        next: (response) => {
          this.sizingBusy.set(false);
          this.syncRuntimeSizingInputs(
            response?.config?.stakeUsd,
            response?.config?.recoveryMaxStakeUsd,
            response?.config?.maxDailyLossUsd,
          );
          this.sizingDirty.set(false);
          this.fetchDashboard();
        },
        error: (err) => {
          this.sizingBusy.set(false);
          this.sizingError.set(
            err?.error?.message ||
              err?.message ||
              "Failed to update runtime controls",
          );
        },
      });
  }

  applyRuntimeSizingDefaults(): void {
    this.runtimeStakeInput.set(
      this.formatRuntimeSizingValue(DEFAULT_BASE_STAKE_USD),
    );
    this.runtimeRecoveryMaxInput.set(
      this.formatRuntimeSizingValue(DEFAULT_RECOVERY_MAX_STAKE_USD),
    );
    this.runtimeMaxDailyLossInput.set(
      this.formatRuntimeSizingValue(DEFAULT_MAX_DAILY_LOSS_USD),
    );
    this.sizingDirty.set(true);
    this.sizingError.set(null);
    this.saveRuntimeSizing(
      DEFAULT_BASE_STAKE_USD,
      DEFAULT_RECOVERY_MAX_STAKE_USD,
      DEFAULT_MAX_DAILY_LOSS_USD,
    );
  }

  setTableSort(table: TableId, key: string): void {
    this.tableSort.update((current) => {
      const existing = current[table];
      const defaultSort = DEFAULT_TABLE_SORT[table];
      let nextSort: TableSortState;
      if (existing.key !== key) {
        nextSort = { key, direction: "desc" };
      } else if (existing.direction === "desc") {
        nextSort = { key, direction: "asc" };
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
    if (current.key !== key) return "↕";
    const defaultSort = DEFAULT_TABLE_SORT[table];
    if (
      current.key === defaultSort.key &&
      current.direction === defaultSort.direction
    )
      return "↕";
    return current.direction === "asc" ? "↑" : "↓";
  }

  private formatChartTs(ts: number, range: ChartRange): string {
    const d = new Date(ts);
    if (
      range === "1H" ||
      range === "3H" ||
      range === "6H" ||
      range === "12H" ||
      range === "LIVE"
    ) {
      return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    }
    if (range === "1D") return d.toLocaleTimeString([], { hour: "numeric" });
    if (range === "1W" || range === "1M")
      return d.toLocaleDateString([], { month: "short", day: "numeric" });
    return d.toLocaleDateString([], { month: "short", year: "2-digit" });
  }

  private formatReadoutTs(ts: number): string {
    return new Date(ts).toLocaleString([], {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
  }

  private rangeStartTs(nowTs: number, range: ChartRange): number | null {
    if (range === "ALL") return null;
    if (range === "LIVE") {
      const start = new Date(nowTs);
      start.setHours(0, 0, 0, 0);
      return start.getTime();
    }
    if (range === "1H") return nowTs - 1 * 60 * 60 * 1000;
    if (range === "3H") return nowTs - 3 * 60 * 60 * 1000;
    if (range === "6H") return nowTs - 6 * 60 * 60 * 1000;
    if (range === "12H") return nowTs - 12 * 60 * 60 * 1000;
    if (range === "1D") return nowTs - 24 * 60 * 60 * 1000;
    if (range === "1W") return nowTs - 7 * 24 * 60 * 60 * 1000;
    if (range === "1M") return nowTs - 30 * 24 * 60 * 60 * 1000;
    if (range === "3M") return nowTs - 90 * 24 * 60 * 60 * 1000;
    if (range === "6M") return nowTs - 182 * 24 * 60 * 60 * 1000;
    if (range === "1Y") return nowTs - 365 * 24 * 60 * 60 * 1000;
    if (range === "3Y") return nowTs - 3 * 365 * 24 * 60 * 60 * 1000;
    if (range === "5Y") return nowTs - 5 * 365 * 24 * 60 * 60 * 1000;
    if (range === "YTD") {
      const d = new Date(nowTs);
      return new Date(d.getFullYear(), 0, 1).getTime();
    }
    return null;
  }

  fetchDashboard(): void {
    if (!this.canFetchDashboard()) {
      this.dashboardFetchInFlight = false;
      this.dashboardRefreshQueued = false;
      this.stopDashboardLoading();
      this.data.set(null);
      this.error.set(null);
      return;
    }

    if (this.dashboardFetchInFlight) {
      this.dashboardRefreshQueued = true;
      return;
    }

    const requestId = ++this.dashboardRequestId;
    const shouldShowInitialLoading = !this.data();
    if (shouldShowInitialLoading) {
      this.startDashboardLoading();
    }
    this.dashboardFetchInFlight = true;
    const runtime = getDashboardRuntimeConfig();
    const headers = this.getAuthHeaders();
    const apiUrl = buildApiUrl("/api/dashboard");

    const finishRequest = () => {
      this.dashboardFetchInFlight = false;
      if (!this.dashboardRefreshQueued) return;
      this.dashboardRefreshQueued = false;
      queueMicrotask(() => this.fetchDashboard());
    };

    if (!runtime.apiBaseUrl && !this.canUseRelativeApiUrl()) {
      this.dashboardFetchInFlight = false;
      this.dashboardRefreshQueued = false;
      this.stopDashboardLoading();
      this.error.set(this.formatDashboardLoadError(null, runtime.apiBaseUrl));
      return;
    }

    this.logDashboardRealtime("Requesting /api/dashboard over HTTP", {
      apiUrl,
      hasSession: Boolean(this.session()),
      reason: this.shouldUseRealtimeDashboard()
        ? "realtime_fallback"
        : "polling_or_local_mode",
    });
    this.http.get<DashboardPayload>(apiUrl, { headers }).subscribe({
      next: (payload) => {
        if (requestId === this.dashboardRequestId && this.canFetchDashboard()) {
          this.logDashboardRealtime("HTTP /api/dashboard response applied", {
            generatedAt: payload.generatedAt,
          });
          this.applyDashboardPayload(payload);
        }
        finishRequest();
      },
      error: (err) => {
        if (requestId === this.dashboardRequestId) {
          this.logDashboardRealtime("HTTP /api/dashboard request failed", {
            status: err?.status ?? null,
            message: err?.error?.message || err?.message || null,
          });
          this.stopDashboardLoading();
          if (err?.status === 401) {
            this.data.set(null);
            this.error.set(
              "Authentication required. Log in with Supabase to load dashboard data.",
            );
            finishRequest();
            return;
          }
          this.data.set(null);
          this.error.set(
            err?.error?.message ||
              err?.message ||
              "Failed to load dashboard data",
          );
        }
        finishRequest();
      },
    });
  }

  private startDashboardLoading(): void {
    this.loading.set(true);
    this.dashboardLoadingElapsedSeconds.set(0);
    if (this.dashboardLoadingTimer) clearInterval(this.dashboardLoadingTimer);
    this.dashboardLoadingTimer = setInterval(() => {
      this.dashboardLoadingElapsedSeconds.update((value) => value + 1);
    }, 1000);
  }

  private stopDashboardLoading(): void {
    this.loading.set(false);
    this.dashboardLoadingElapsedSeconds.set(0);
    if (this.dashboardLoadingTimer) {
      clearInterval(this.dashboardLoadingTimer);
      this.dashboardLoadingTimer = null;
    }
  }

  private fetchCredentialStatus(): void {
    const headers = this.getAuthHeaders();
    if (!headers || !this.session()) {
      this.credentialStatus.set(null);
      return;
    }

    this.credentialsLoading.set(true);
    this.credentialsError.set(null);
    this.credentialStatusError.set(null);

    this.http
      .get<{
        ok: boolean;
        credentials: CredentialStatus;
      }>(buildApiUrl("/api/credentials"), { headers })
      .subscribe({
        next: (response) => {
          this.credentialsLoading.set(false);
          this.credentialStatusError.set(null);
          this.credentialStatus.set(response.credentials || null);
          if (response.credentials?.hasCredential) {
            this.credentialApiKeyId.set("");
            this.credentialPem.set("");
            this.credentialPemFileName.set("");
            this.credentialReplaceMode.set(false);
            this.credentialDeleteConfirm.set(false);
            if (this.credentialHealthState() !== "healthy") {
              this.scheduleStoredCredentialHealthCheck(0);
            }
          } else {
            this.resetCredentialHealthCheck();
          }
        },
        error: (err) => {
          this.credentialsLoading.set(false);
          this.credentialStatus.set(null);
          this.credentialStatusError.set(
            this.describeCredentialStatusBanner(err),
          );
        },
      });
  }

  private getAuthHeaders(): { Authorization: string } | undefined {
    const runtime = getDashboardRuntimeConfig();
    const accessToken = this.session()?.access_token || runtime.apiToken;
    return accessToken ? { Authorization: `Bearer ${accessToken}` } : undefined;
  }

  private describeCredentialError(
    err: { status?: number; error?: { message?: string }; message?: string },
    fallback: string,
  ): string {
    if (err?.status === 404) {
      return "Credential API not found. Restart `npm run monitor:api` so the local backend picks up the new routes.";
    }

    return err?.error?.message || err?.message || fallback;
  }

  private describeCredentialStatusBanner(err: { status?: number }): string {
    if (err?.status === 404) {
      return "Kalshi credential tools are unavailable right now. Restart the local backend, then open the key icon in the top-right header.";
    }

    return "Kalshi credentials need attention. Open the key icon in the top-right header to review or upload your API key ID and PEM file.";
  }

  private resetCredentialHealthCheck(
    state: CredentialHealthState = "idle",
    message: string | null = null,
  ): void {
    if (this.credentialHealthTimer) {
      clearTimeout(this.credentialHealthTimer);
      this.credentialHealthTimer = null;
    }
    this.credentialHealthRequestId += 1;
    this.credentialHealthState.set(state);
    this.credentialHealthMessage.set(message);
  }

  private scheduleDraftCredentialHealthCheck(delayMs = 350): void {
    this.resetCredentialHealthCheck();

    if (!this.credentialPem().trim() || !this.credentialPemFileName().trim()) {
      return;
    }

    if (!this.credentialApiKeyId().trim()) {
      this.credentialHealthMessage.set(
        "Add your Kalshi API key ID to run the Kalshi API health check.",
      );
      return;
    }

    const headers = this.getAuthHeaders();
    if (!headers) {
      this.credentialHealthState.set("failed");
      this.credentialHealthMessage.set(
        "Sign in before running the Kalshi API health check.",
      );
      return;
    }

    this.credentialHealthState.set("checking");
    this.credentialHealthMessage.set(
      "Checking the Kalshi API with the selected PEM file...",
    );
    const requestId = ++this.credentialHealthRequestId;

    this.credentialHealthTimer = setTimeout(() => {
      this.credentialHealthTimer = null;
      this.runCredentialHealthCheck(requestId, headers, {
        checkMode: "draft",
        kalshiApiKeyId: this.credentialApiKeyId().trim(),
        privateKeyPem: this.credentialPem(),
      });
    }, delayMs);
  }

  private scheduleStoredCredentialHealthCheck(delayMs = 350): void {
    this.resetCredentialHealthCheck();

    if (!this.hasStoredCredential() || this.credentialReplaceMode()) {
      return;
    }

    const headers = this.getAuthHeaders();
    if (!headers) {
      return;
    }

    this.credentialHealthState.set("checking");
    this.credentialHealthMessage.set(
      "Checking the stored Kalshi credentials...",
    );
    const requestId = ++this.credentialHealthRequestId;

    this.credentialHealthTimer = setTimeout(() => {
      this.credentialHealthTimer = null;
      this.runCredentialHealthCheck(requestId, headers, {
        checkMode: "stored",
      });
    }, delayMs);
  }

  rerunCredentialHealthCheck(): void {
    if (this.credentialsSaving()) return;
    this.credentialHealthInfoOpen.set(false);

    if (this.credentialPem().trim() && this.credentialPemFileName().trim()) {
      this.scheduleDraftCredentialHealthCheck(0);
      return;
    }

    if (this.hasStoredCredential() && !this.credentialReplaceMode()) {
      this.scheduleStoredCredentialHealthCheck(0);
      return;
    }

    if (this.credentialApiKeyId().trim()) {
      this.resetCredentialHealthCheck(
        "idle",
        "Upload a PEM file to run the Kalshi API health check.",
      );
      return;
    }

    this.resetCredentialHealthCheck(
      "idle",
      "Add your Kalshi API key ID and PEM file to run the Kalshi API health check.",
    );
  }

  private runCredentialHealthCheck(
    requestId: number,
    headers: { Authorization: string },
    body: {
      checkMode: "draft" | "stored";
      kalshiApiKeyId?: string;
      privateKeyPem?: string;
    },
  ): void {
    this.http
      .post<{
        ok: boolean;
        healthy: boolean;
        checkedAt?: string;
        message?: string;
      }>(buildApiUrl("/api/credentials/check"), body, { headers })
      .subscribe({
        next: (response) => {
          if (requestId !== this.credentialHealthRequestId) return;
          this.credentialHealthState.set(
            response.healthy ? "healthy" : "failed",
          );
          this.credentialHealthMessage.set(
            response.message || "Kalshi API credentials verified successfully.",
          );
        },
        error: (err) => {
          if (requestId !== this.credentialHealthRequestId) return;
          this.credentialHealthState.set("failed");
          this.credentialHealthMessage.set(
            this.describeCredentialError(
              err,
              "Kalshi API health check failed.",
            ),
          );
        },
      });
  }

  private syncRuntimeSizingInputs(
    stakeUsd: number | null | undefined,
    recoveryMaxStakeUsd: number | null | undefined,
    maxDailyLossUsd: number | null | undefined,
  ): void {
    const nextStakeUsd = Number.isFinite(Number(stakeUsd))
      ? Number(stakeUsd)
      : DEFAULT_BASE_STAKE_USD;
    const nextRecoveryMaxStakeUsd = Number.isFinite(Number(recoveryMaxStakeUsd))
      ? Number(recoveryMaxStakeUsd)
      : DEFAULT_RECOVERY_MAX_STAKE_USD;
    const nextMaxDailyLossUsd = Number.isFinite(Number(maxDailyLossUsd))
      ? Number(maxDailyLossUsd)
      : DEFAULT_MAX_DAILY_LOSS_USD;
    this.runtimeStakeInput.set(this.formatRuntimeSizingValue(nextStakeUsd));
    this.runtimeRecoveryMaxInput.set(
      this.formatRuntimeSizingValue(nextRecoveryMaxStakeUsd),
    );
    this.runtimeMaxDailyLossInput.set(
      this.formatRuntimeSizingValue(nextMaxDailyLossUsd),
    );
  }

  private resetRuntimeSettingsDraft(): void {
    const d = this.data();
    if (d) {
      this.syncRuntimeSizingInputs(
        d.config.stakeUsd,
        d.config.recoveryMaxStakeUsd,
        d.config.maxDailyLossUsd,
      );
    } else {
      this.syncRuntimeSizingInputs(
        DEFAULT_BASE_STAKE_USD,
        DEFAULT_RECOVERY_MAX_STAKE_USD,
        DEFAULT_MAX_DAILY_LOSS_USD,
      );
    }
    this.sizingDirty.set(false);
    this.sizingError.set(null);
  }

  private formatRuntimeSizingValue(value: number): string {
    if (!Number.isFinite(value)) return "";
    return String(Number(value.toFixed(2)));
  }

  private parseRuntimeSizingInput(value: string): number | null {
    const parsed = Number(String(value).trim());
    return Number.isFinite(parsed) ? parsed : null;
  }

  trackByTicker(index: number, row: { ticker: string }): string {
    return `${row.ticker}-${index}`;
  }

  numberTone(value: unknown): "pos" | "neg" | "" {
    if (typeof value !== "number" || !Number.isFinite(value) || value === 0)
      return "";
    return value > 0 ? "pos" : "neg";
  }

  asString(value: unknown): string {
    if (typeof value === "string") return value;
    if (value === null || value === undefined) return "-";
    if (typeof value === "number") return String(value);
    if (typeof value === "boolean") return value ? "true" : "false";
    return JSON.stringify(value);
  }

  prettyKey(key: string): string {
    return key
      .replace(/([a-z])([A-Z])/g, "$1 $2")
      .replace(/_/g, " ")
      .replace(/\b\w/g, (char) => char.toUpperCase());
  }

  logActionLabel(action: string | undefined): string {
    return String(action || "unknown")
      .replace(/_/g, " ")
      .toUpperCase();
  }

  logActionTone(action: string | undefined): string {
    const value = String(action || "");
    if (
      value.includes("error") ||
      value.includes("halt") ||
      value.includes("fatal")
    )
      return "log-action--bad";
    if (value.includes("filled")) return "log-action--good";
    if (value.includes("submit")) return "log-action--info";
    if (value.includes("not_filled")) return "log-action--warn";
    return "log-action--neutral";
  }

  logHeadline(item: LogRecord): string {
    const message = item["message"];
    if (typeof message === "string" && message.trim()) return message;

    const eventTitle = item["eventTitle"];
    if (typeof eventTitle === "string" && eventTitle.trim()) {
      const minute = item["minute"];
      const score = item["score"];
      const bits = [
        eventTitle.trim(),
        minute !== undefined && minute !== null ? `${minute}'` : null,
        typeof score === "string" && score ? score : null,
      ].filter(Boolean);
      return bits.join(" • ");
    }

    const competition = item["competition"];
    if (typeof competition === "string" && competition.trim())
      return competition.trim();
    return this.logActionLabel(item.action);
  }

  logFields(item: LogRecord): LogField[] {
    return Object.entries(item)
      .filter(([key]) => key !== "ts" && key !== "action" && key !== "message")
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
    const multiplier = sort.direction === "asc" ? 1 : -1;
    return [...rows].sort((left, right) => {
      const primary =
        this.compareValues(accessor(left), accessor(right)) * multiplier;
      if (primary !== 0) return primary;
      return this.compareValues(JSON.stringify(left), JSON.stringify(right));
    });
  }

  private compareValues(left: unknown, right: unknown): number {
    if (left === right) return 0;
    if (left === null || left === undefined || left === "") return 1;
    if (right === null || right === undefined || right === "") return -1;
    if (typeof left === "number" && typeof right === "number")
      return left - right;
    if (typeof left === "boolean" && typeof right === "boolean")
      return Number(left) - Number(right);
    return String(left).localeCompare(String(right), undefined, {
      numeric: true,
      sensitivity: "base",
    });
  }

  private toTimestamp(value: string | null | undefined): number | null {
    if (!value) return null;
    const ts = new Date(value).getTime();
    return Number.isFinite(ts) ? ts : null;
  }

  closedTradeTrackKey(trade: ClosedTradeRecord): string {
    return this.closedTradeKey(trade);
  }

  private closedTradeKey(trade: ClosedTradeRecord): string {
    return `${trade.ticker}@${trade.settled_time}@${trade.placed_context?.tradeLegId || trade.placed_context?.markedAt || "base"}`;
  }

  private openTradeKey(trade: TradeRecord): string {
    return `${trade.ticker}@${trade.last_updated_ts || trade.placed_context?.markedAt || trade.event_ticker || trade.ticker}`;
  }

  private fpStringToNumber(value: string | undefined): number | null {
    if (value === null || value === undefined) return null;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  private pushRecoveryAttempt(
    attemptsByQueue: Map<string, RecoveryAttemptView[]>,
    queueId: string,
    attempt: RecoveryAttemptView,
  ): void {
    if (!queueId || !attempt.tradeKey) return;
    const attempts = attemptsByQueue.get(queueId) || [];
    const existingIndex = attempts.findIndex(
      (item) => item.tradeKey === attempt.tradeKey,
    );
    if (existingIndex >= 0) {
      attempts[existingIndex] = {
        ...attempts[existingIndex],
        ...attempt,
        allocatedRecoveryUsd:
          attempt.allocatedRecoveryUsd ||
          attempts[existingIndex].allocatedRecoveryUsd ||
          0,
      };
    } else {
      attempts.push(attempt);
    }
    attemptsByQueue.set(queueId, attempts);
  }

  logPrimaryFields(item: LogRecord): LogField[] {
    const priority = [
      "eventTitle",
      "competition",
      "leadingTeam",
      "score",
      "minute",
      "stakeUsd",
      "fillCount",
      "count",
      "cards",
      "leaderVsTrailingCards",
    ];
    const fields = this.logFields(item);
    return priority
      .map((key) => fields.find((field) => field.key === key))
      .filter((field): field is LogField => Boolean(field));
  }

  logSecondaryFields(item: LogRecord): LogField[] {
    const primaryKeys = new Set(
      this.logPrimaryFields(item).map((field) => field.key),
    );
    return this.logFields(item).filter((field) => !primaryKeys.has(field.key));
  }

  recoveryAttemptsFor(row: RecoveryQueueRow): RecoveryAttemptView[] {
    return this.directRecoveryAttemptMap().get(row.queueId) || [];
  }

  recoveryCreditsFor(row: RecoveryQueueRow): RecoveryCreditView[] {
    return this.recoveryCreditMap().get(row.queueId) || [];
  }

  latestRecoveryAttempt(row: RecoveryQueueRow): RecoveryAttemptView | null {
    const attempts = this.recoveryAttemptsFor(row);
    return attempts.length ? attempts[attempts.length - 1] : null;
  }

  recoveryAttemptStakeUsd(
    attempt: RecoveryAttemptView | null | undefined,
  ): number | null {
    if (!attempt) return null;
    if (attempt.stakeUsdTarget !== null && attempt.stakeUsdTarget !== undefined)
      return attempt.stakeUsdTarget;
    if (attempt.amountBetUsd !== null && attempt.amountBetUsd !== undefined)
      return attempt.amountBetUsd;
    return null;
  }

  recoveryAttemptTargetUsd(
    attempt: RecoveryAttemptView | null | undefined,
  ): number | null {
    if (!attempt) return null;
    if (
      attempt.targetProfitUsd !== null &&
      attempt.targetProfitUsd !== undefined
    )
      return attempt.targetProfitUsd;
    return null;
  }

  recoveryAttemptResultLabel(attempt: RecoveryAttemptView): string {
    if (attempt.status === "OPEN") return "OPEN";
    if ((attempt.pnlUsd || 0) > 0) return "WIN";
    if ((attempt.pnlUsd || 0) < 0) return "LOSS";
    return "PUSH";
  }

  recoveryAttemptsTotalStakeUsd(row: RecoveryQueueRow): number | null {
    const total = this.recoveryAttemptsFor(row).reduce((sum, attempt) => {
      const stakeUsd = this.recoveryAttemptStakeUsd(attempt);
      return stakeUsd === null || stakeUsd === undefined ? sum : sum + stakeUsd;
    }, 0);
    return total > 0 ? Number(total.toFixed(4)) : null;
  }

  recoveryAttemptsTotalTargetUsd(row: RecoveryQueueRow): number | null {
    const total = this.recoveryAttemptsFor(row).reduce((sum, attempt) => {
      const targetUsd = this.recoveryAttemptTargetUsd(attempt);
      return targetUsd === null || targetUsd === undefined
        ? sum
        : sum + targetUsd;
    }, 0);
    return total > 0 ? Number(total.toFixed(4)) : null;
  }

  recoveryAttemptsTotalPnlUsd(row: RecoveryQueueRow): number | null {
    const attempts = this.recoveryAttemptsFor(row).filter(
      (attempt) =>
        attempt.pnlUsd !== null &&
        attempt.pnlUsd !== undefined &&
        attempt.status === "SETTLED",
    );
    if (!attempts.length) return null;
    const total = attempts.reduce(
      (sum, attempt) => sum + Number(attempt.pnlUsd || 0),
      0,
    );
    return Number(total.toFixed(4));
  }

  recoveryCreditsTotalAllocatedUsd(row: RecoveryQueueRow): number | null {
    const credits = this.recoveryCreditsFor(row);
    if (!credits.length) return null;
    const total = credits.reduce(
      (sum, credit) => sum + Number(credit.allocatedRecoveryUsd || 0),
      0,
    );
    return Number(total.toFixed(4));
  }

  recoveryCreditsTotalPnlUsd(row: RecoveryQueueRow): number | null {
    const credits = this.recoveryCreditsFor(row).filter(
      (credit) => credit.pnlUsd !== null && credit.pnlUsd !== undefined,
    );
    if (!credits.length) return null;
    const total = credits.reduce(
      (sum, credit) => sum + Number(credit.pnlUsd || 0),
      0,
    );
    return Number(total.toFixed(4));
  }

  recoveryConditionSummary(conditions: string[] | null | undefined): string {
    const labels = (conditions || []).map((condition) => {
      switch (condition) {
        case "late_two_goal_leader":
          return "75'+ leader, 2+ goals";
        case "anytime_large_lead_signal":
          return "Anytime large lead signal";
        case "current_lead_signal":
          return "Current lead signal";
        case "late_lead_signal":
          return "Late lead signal";
        case "late_tie_signal":
          return "Late tie signal";
        default:
          return condition;
      }
    });
    return labels.length
      ? labels.join(", ")
      : "75'+ leader, 2+ goals, Anytime large lead signal";
  }

  statusClass(status: string | undefined): string {
    switch (status) {
      case "UP_TRADING":
        return "status-good";
      case "UP_DRY_RUN":
        return "status-info";
      case "UP_BLOCKED_STOP_LOSS":
        return "status-warn";
      case "UP_DEGRADED":
        return "status-bad";
      case "DOWN":
        return "status-down";
      default:
        return "status-neutral";
    }
  }

  agentStatusLabel(status: string | undefined): string {
    switch (status) {
      case "UP_TRADING":
        return "Live Trading";
      case "UP_DRY_RUN":
        return "Paper Trading";
      case "UP_BLOCKED_STOP_LOSS":
        return "Paused for Stop-Loss";
      case "UP_DEGRADED":
        return "Running with Issues";
      case "DOWN":
        return "Offline";
      case "STARTING":
        return "Starting Up";
      default:
        return "Checking Status";
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
    const colors =
      this.theme() === "dark"
        ? {
            grid: "#1f2d40",
            text: "#9aa5b1",
            line: delta >= 0 ? "#00c805" : "#ff5000",
          }
        : {
            grid: "#e6e9ed",
            text: "#6f7277",
            line: delta >= 0 ? "#00c805" : "#ff5000",
          };

    const labels = points.map((pt) =>
      this.formatChartTs(pt.ts, this.chartRange()),
    );
    const values = points.map((pt) => Number(pt.pnl.toFixed(4)));
    const currency = new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: "USD",
      maximumFractionDigits: 2,
    });

    if (!this.chartInstance) {
      const config: ChartConfiguration<"line"> = {
        type: "line",
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
              cubicInterpolationMode: "monotone",
              fill: false,
            },
          ],
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          animation: false,
          interaction: {
            mode: "index",
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
    this.chartInstance.update("none");
  }
}
