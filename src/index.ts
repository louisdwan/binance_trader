import 'dotenv/config';
import fs from 'fs/promises';
import http, { type IncomingMessage, type ServerResponse } from 'http';
import path from 'path';
import { pathToFileURL } from 'url';
import logger from './logger';
import {
  MarketDataProvider,
  type Ticker,
  type CandleData,
} from './marketData';
import {
  TrendPullbackStrategy,
  BreakoutConfirmationStrategy,
  MeanReversionDipBuyStrategy,
  BaseStrategy,
  type StrategyConfig,
  type StrategySignal,
} from './strategy';
import {
  OrderExecutor,
  type ExecutionConfig,
  type AccountBalance,
  type AccountInfo,
  type OrderStateNormalizationResult,
} from './execution';
import { RiskManager, type RiskConfig, type Position } from './risk';
import { TradeJournal } from './journal';
import {
  FileStateStore,
  type PersistedTradingState,
  type LegacyPersistedTradingState,
} from './runtime/stateStore';

type BinanceEnvironment = 'testnet' | 'live';
type SystemState = 'idle' | 'running' | 'paused' | 'stopping';

type TradingSystemStatus = {
  symbol: string;
  symbols: string[];
  state: SystemState;
  isCycleRunning: boolean;
  cycleIntervalMs: number | null;
  lastCycleStartedAt: number | null;
  lastCycleCompletedAt: number | null;
  lastCycleError: string | null;
  entrySignalThreshold: number;
  openPosition: ReturnType<RiskManager['getPosition']>;
  openPositions: ReturnType<RiskManager['getAllPositions']>;
  riskMetrics: ReturnType<RiskManager['getRiskMetrics']>;
  journalStats: ReturnType<TradeJournal['calculateStats']>;
  openOrders: ReturnType<OrderExecutor['getOpenOrders']>;
  dryRun: boolean | undefined;
};

type StatusSeverity = 'ok' | 'warning' | 'critical';
type RecommendedAction = 'none' | 'pause' | 'resume' | 'close-position' | 'kill-switch';
type OperatorStateCode =
  | 'idle'
  | 'running-cycle'
  | 'paused-manual'
  | 'awaiting-next-cycle'
  | 'position-open'
  | 'risk-blocked'
  | 'cycle-error'
  | 'stale-open-orders';
type FailureType =
  | 'market-data'
  | 'exchange'
  | 'order-lifecycle'
  | 'reconciliation'
  | 'risk'
  | 'validation'
  | 'state'
  | 'operator'
  | 'unknown';

type OperatorLastError = {
  type: FailureType;
  source: string;
  message: string;
  occurredAt: number;
};

type OperatorHealthPayload = {
  ok: boolean;
  service: 'binance-trader';
  time: number;
  uptimeMs: number;
  state: SystemState;
  isCycleRunning: boolean;
  authRequired: boolean;
  status: TradingSystemStatus;
  deprecated: {
    statusInHealth: boolean;
    statusEndpoint: '/status';
  };
};

type OperatorStatusPayload = TradingSystemStatus & {
  observedAt: number;
  timestamps: {
    processStartedAt: number;
    stateUpdatedAt: number;
    lastCycleStartedAt: number | null;
    lastCycleCompletedAt: number | null;
    lastSuccessfulCycleAt: number | null;
    accountSnapshotAt: number | null;
    journalUpdatedAt: number | null;
    statusGeneratedAt: number;
  };
  freshness: {
    cycleAgeMs: number | null;
    lastSuccessfulCycleAgeMs: number | null;
    accountSnapshotAgeMs: number | null;
    journalAgeMs: number | null;
  };
  operatorState: {
    mode: 'active' | 'idle' | 'paused';
    reasonCode: OperatorStateCode;
    reason: string;
  };
  severity: StatusSeverity;
  recommendedAction: RecommendedAction;
  recommendedActionReason: string;
  controls: {
    pauseAvailable: boolean;
    resumeAvailable: boolean;
    closePositionAvailable: boolean;
    killSwitchAvailable: false;
  };
  riskVisibility: {
    totalExposure: number;
    perSymbolExposure: Array<{
      symbol: string;
      quantity: number;
      notional: number;
      unrealizedPnL: number;
      unrealizedPnLPercent: number;
      holdingTimeMs: number | null;
      protectiveState: {
        active: boolean;
        mode: 'bot-managed-atr-stop' | 'none';
        stopPrice: number | null;
        takeProfitPrice: number | null;
      };
    }>;
    rollingDrawdown: {
      current: number;
      percent: number;
      peakEquity: number;
    };
    lossStreak: {
      current: number;
      worstRecent: number;
    };
  };
  openOrderVisibility: {
    totalOpenOrders: number;
    staleThresholdMs: number;
    staleOpenOrders: Array<{
      id?: string;
      symbol: string;
      side: string;
      type: string;
      status: string;
      ageMs: number;
      stale: boolean;
    }>;
    orders: Array<{
      id?: string;
      symbol: string;
      side: string;
      type: string;
      status: string;
      price?: number;
      quantity: number;
      timestamp: number;
      ageMs: number;
      stale: boolean;
    }>;
  };
  performance: {
    feeAware: boolean;
    averageHoldingTimeMs: number | null;
    rollingPnL: {
      last24h: number;
      last7d: number;
      last30d: number;
    };
    symbolSummary: Array<{
      symbol: string;
      trades: number;
      winRate: number;
      totalPnL: number;
      averageHoldingTimeMs: number | null;
    }>;
  };
  failures: {
    countsByType: Record<FailureType, number>;
    lastError: OperatorLastError | null;
  };
  reconciliation: {
    orders: OrderStateNormalizationResult & {
      lastReason: string | null;
      cumulativeReclassifiedFilled: number;
      cumulativeReclassifiedFailed: number;
    };
  };
};

type ControlServerConfig = {
  host: string;
  port: number;
  authToken?: string;
};

type TradingSystemOptions = {
  quoteAsset: string;
  baseAssets: Record<string, string>;
  stateStore: FileStateStore;
  liveMaxOrderNotional?: number;
  strategyTemplates: StrategyTemplateConfig[];
};

type RankedStrategyCandidate = StrategySignal & {
  rankScore: number;
};

type StrategyTemplateConfig = {
  type: StrategyConfig['type'];
  name: string;
  enabled: boolean;
  parameters: Record<string, unknown>;
};

type BotConfig = {
  symbols: string[];
  strategies: StrategyTemplateConfig[];
};

type SymbolRuntimeContext = {
  symbol: string;
  ticker: Ticker;
  candles: CandleData[];
  higherTimeframeCandles: CandleData[];
  atr: number;
  atrPercent: number;
  selectedBuySignal: RankedStrategyCandidate | null;
  selectedSellSignal: RankedStrategyCandidate | null;
  strategySignals: StrategySignal[];
};

function normalizeSymbol(symbol: string): string {
  const normalized = symbol.trim().toUpperCase();

  if (!/^[A-Z0-9]+$/.test(normalized)) {
    throw new Error(`Invalid trading symbol value "${symbol}"`);
  }

  return normalized;
}

function getQuoteAsset(symbol: string): string {
  const knownQuoteAssets = [
    'USDT',
    'USDC',
    'FDUSD',
    'TUSD',
    'DAI',
    'EUR',
    'TRY',
    'BRL',
    'GBP',
    'AUD',
    'BUSD',
    'BTC',
    'ETH',
    'BNB',
  ];

  const quoteAsset = knownQuoteAssets.find((asset) => symbol.endsWith(asset));
  if (!quoteAsset) {
    throw new Error(
      `Unable to determine quote asset for symbol "${symbol}". Add support in getQuoteAsset().`
    );
  }

  return quoteAsset;
}

function getBaseAsset(symbol: string): string {
  const quoteAsset = getQuoteAsset(symbol);
  const baseAsset = symbol.slice(0, symbol.length - quoteAsset.length);

  if (!baseAsset) {
    throw new Error(`Unable to determine base asset for symbol "${symbol}"`);
  }

  return baseAsset;
}

function getConfigFilePath(): string {
  const rawValue = process.env.BOT_CONFIG_FILE?.trim();
  return rawValue ? path.resolve(rawValue) : path.resolve(process.cwd(), 'config', 'trading.json');
}

function getDefaultBotConfig(): BotConfig {
  return {
    symbols: [normalizeSymbol(process.env.TRADING_SYMBOL || 'BTCUSDT')],
    strategies: [
      {
        type: 'trend_pullback',
        name: 'Trend Pullback Strategy',
        enabled: true,
        parameters: {
          fastPeriod: 5,
          pullbackPeriod: 20,
          trendPeriod: 200,
          pullbackTolerancePercent: 0.15,
          trendBufferPercent: 0.35,
          minTrendStrengthPercent: 0.03,
        },
      },
      {
        type: 'breakout_confirmation',
        name: 'Breakout Confirmation Strategy',
        enabled: true,
        parameters: {
          breakoutLookback: 20,
          volumeLookback: 20,
          breakoutBufferPercent: 0.05,
          volumeMultiplier: 1.2,
          trendPeriod: 200,
        },
      },
      {
        type: 'mean_reversion_dip_buy',
        name: 'Mean Reversion Dip Buy Strategy',
        enabled: true,
        parameters: {
          bandPeriod: 20,
          bandStdDevMultiplier: 2,
          trendPeriod: 200,
          reclaimPercent: 0.05,
        },
      },
    ],
  };
}

async function loadBotConfig(): Promise<BotConfig> {
  const configFilePath = getConfigFilePath();

  try {
    const raw = await fs.readFile(configFilePath, 'utf8');
    const parsed = JSON.parse(raw) as Partial<BotConfig>;
    const symbols = (parsed.symbols ?? []).map((symbol) => normalizeSymbol(String(symbol)));
    const strategies = (parsed.strategies ?? []).map((strategy, index) => {
      const typedStrategy = strategy as Partial<StrategyTemplateConfig>;
      if (
        typedStrategy.type !== 'trend_pullback' &&
        typedStrategy.type !== 'breakout_confirmation' &&
        typedStrategy.type !== 'mean_reversion_dip_buy'
      ) {
        throw new Error(`Invalid strategy type at index ${index}`);
      }

      return {
        type: typedStrategy.type,
        name: typedStrategy.name?.trim() || typedStrategy.type,
        enabled: typedStrategy.enabled ?? true,
        parameters: (typedStrategy.parameters as Record<string, unknown> | undefined) ?? {},
      };
    });

    if (symbols.length === 0) {
      throw new Error('Config must include at least one symbol');
    }

    if (strategies.length === 0) {
      throw new Error('Config must include at least one strategy');
    }

    return { symbols, strategies };
  } catch (error: unknown) {
    if (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      (error as NodeJS.ErrnoException).code === 'ENOENT'
    ) {
      const defaultConfig = getDefaultBotConfig();
      const configFilePath = getConfigFilePath();
      await fs.mkdir(path.dirname(configFilePath), { recursive: true });
      await fs.writeFile(configFilePath, JSON.stringify(defaultConfig, null, 2), 'utf8');
      logger.warn({ configFilePath }, 'Bot config file not found; wrote default config');
      return defaultConfig;
    }

    throw error;
  }
}

class TradingSystem {
  private static readonly staleOpenOrderThresholdMs = 5 * 60 * 1000;
  private marketDataProvider: MarketDataProvider;
  private orderExecutor: OrderExecutor;
  private riskManager: RiskManager;
  private journal: TradeJournal;
  private openTrades: Map<string, { tradeId: string; entryAtr: number }> = new Map();
  private readonly symbols: string[];
  private readonly quoteAsset: string;
  private readonly baseAssets: Record<string, string>;
  private readonly strategyTemplates: StrategyTemplateConfig[];
  private readonly stateStore: FileStateStore;
  private readonly liveMaxOrderNotional?: number;
  private readonly entrySignalThreshold: number = 0.25;
  private readonly maxHoldTimeMs: number = 15 * 60 * 1000;
  private readonly stopLossAtrMultiple: number = 1;
  private readonly takeProfitAtrMultiple: number = 2.5;
  private readonly minAtrPercentForEntry: number = 0.05;
  private readonly dryRun: boolean | undefined;
  private loopIntervalMs: number | null = null;
  private loopTimer: NodeJS.Timeout | null = null;
  private cyclePromise: Promise<void> | null = null;
  private state: SystemState = 'idle';
  private readonly startedAt: number = Date.now();
  private stateUpdatedAt: number = this.startedAt;
  private lastCycleStartedAt: number | null = null;
  private lastCycleCompletedAt: number | null = null;
  private lastSuccessfulCycleAt: number | null = null;
  private lastCycleError: string | null = null;
  private pauseReason: string | null = null;
  private lastAccountSnapshotAt: number | null = null;
  private lastJournalUpdatedAt: number | null = null;
  private lastError: OperatorLastError | null = null;
  private lastOrderNormalization: OperatorStatusPayload['reconciliation']['orders'] = {
    normalizedAt: 0,
    staleThresholdMs: OrderExecutor.getPendingOrderStaleAfterMs(),
    stalePendingOrdersFound: 0,
    reclassifiedFilled: 0,
    reclassifiedFailed: 0,
    unresolvedStaleOrders: 0,
    touchedOrderIds: [],
    lastReason: null,
    cumulativeReclassifiedFilled: 0,
    cumulativeReclassifiedFailed: 0,
  };
  private failureCounts: Record<FailureType, number> = {
    'market-data': 0,
    exchange: 0,
    'order-lifecycle': 0,
    reconciliation: 0,
    risk: 0,
    validation: 0,
    state: 0,
    operator: 0,
    unknown: 0,
  };

  constructor(
    marketDataProvider: MarketDataProvider,
    executionConfig: ExecutionConfig,
    riskConfig: RiskConfig,
    initialBalance: number,
    symbols: string[],
    options: TradingSystemOptions
  ) {
    this.marketDataProvider = marketDataProvider;
    this.orderExecutor = new OrderExecutor(executionConfig);
    this.riskManager = new RiskManager(riskConfig, initialBalance);
    this.journal = new TradeJournal();
    this.symbols = symbols;
    this.quoteAsset = options.quoteAsset;
    this.baseAssets = options.baseAssets;
    this.strategyTemplates = options.strategyTemplates;
    this.stateStore = options.stateStore;
    this.liveMaxOrderNotional = options.liveMaxOrderNotional;
    this.dryRun = executionConfig.dryRun;

    logger.info(
      {
        symbols: this.symbols,
        quoteAsset: this.quoteAsset,
        stateFile: this.stateStore.getFilePath(),
        liveMaxOrderNotional: this.liveMaxOrderNotional,
      },
      'Trading system initialized'
    );
  }

  async runCycle(): Promise<void> {
    if (this.state === 'paused') {
      logger.info({ symbols: this.symbols }, 'Skipping cycle because trading is paused');
      return;
    }

    try {
      this.logRiskMetrics('Risk metrics before trade evaluation');
      for (const symbol of this.symbols) {
        const context = await this.evaluateSymbol(symbol);
        await this.processSymbolContext(context);
      }

      const stats = this.journal.calculateStats();
      logger.info({ stats }, 'Trading cycle completed');
    } catch (error) {
      logger.error({ error }, 'Error in trading cycle');
      throw error;
    }
  }

  private async evaluateSymbol(symbol: string): Promise<SymbolRuntimeContext> {
    const ticker = await this.marketDataProvider.getTicker(symbol);
    logger.info({ ticker }, 'Market data fetched successfully');

    const candles = await this.marketDataProvider.getCandles(symbol, '1m', 100);
    const higherTimeframeCandles = await this.marketDataProvider.getCandles(symbol, '15m', 240);
    logger.info(
      {
        symbol,
        candleCount: candles.length,
        higherTimeframeCandleCount: higherTimeframeCandles.length,
      },
      'Candle data retrieved'
    );

    const strategies = this.buildStrategies(symbol, higherTimeframeCandles);
    const strategySignals = strategies.map((strategy) => {
      strategy.updateCandles(candles);
      return strategy.analyze();
    });
    const selectedBuySignal = this.selectBestCandidate(
      strategySignals.filter((signal) => signal.action === 'BUY')
    );
    const selectedSellSignal = this.selectBestCandidate(
      strategySignals.filter((signal) => signal.action === 'SELL')
    );
    logger.info(
      {
        symbol,
        strategySignals: strategySignals.map((signal) => ({
          strategyName: signal.strategyName,
          action: signal.action,
          confidence: signal.confidence,
          reasoning: signal.reasoning,
        })),
        selectedBuySignal,
        selectedSellSignal,
      },
      'Strategy scan completed'
    );

    const atr = this.calculateATR(candles, 14);
    const atrPercent = ticker.price > 0 ? (atr / ticker.price) * 100 : 0;

    return {
      symbol,
      ticker,
      candles,
      higherTimeframeCandles,
      atr,
      atrPercent,
      selectedBuySignal,
      selectedSellSignal,
      strategySignals,
    };
  }

  private async processSymbolContext(context: SymbolRuntimeContext): Promise<void> {
    const existingPosition = this.riskManager.getPosition(context.symbol);
    const entryContext = {
      symbol: context.symbol,
      price: context.ticker.price,
      atr: context.atr,
      atrPercent: context.atrPercent,
      minAtrPercentForEntry: this.minAtrPercentForEntry,
      entrySignalThreshold: this.entrySignalThreshold,
      existingPosition: Boolean(existingPosition),
      selectedBuySignal: context.selectedBuySignal,
      selectedSellSignal: context.selectedSellSignal,
    };

    if (existingPosition) {
      this.riskManager.updatePositionPrice(context.symbol, context.ticker.price);

      const exitReason = this.getExitReason(
        context.symbol,
        existingPosition.entryPrice,
        context.ticker.price,
        context.selectedSellSignal?.action ?? 'HOLD',
        context.selectedSellSignal?.strategyName
      );

      if (exitReason) {
        await this.closePosition(context.symbol, context.ticker.price, exitReason);
        this.logRiskMetrics(`Risk metrics after closing position for ${context.symbol}`);
        return;
      }
    }

    if (
      context.selectedBuySignal &&
      context.selectedBuySignal.action === 'BUY' &&
      context.selectedBuySignal.confidence >= this.entrySignalThreshold
    ) {
      if (!this.riskManager.validateRisk()) {
        logger.warn(entryContext, 'Skipping BUY because portfolio risk limits are exceeded');
        return;
      }

      if (context.atrPercent < this.minAtrPercentForEntry) {
        logger.info(entryContext, 'Skipping BUY because volatility is too low for the pullback setup');
        return;
      }

      if (existingPosition) {
        logger.info(entryContext, 'Skipping BUY because a position is already open');
        return;
      }

      const rawQuantity = this.calculateOrderQuantity(
        context.ticker.price,
        context.atr * this.stopLossAtrMultiple
      );
      const preparedOrder = await this.orderExecutor.prepareOrder({
        symbol: context.symbol,
        side: 'BUY',
        type: 'MARKET',
        quantity: rawQuantity,
        price: context.ticker.price,
        status: 'PENDING',
      });

      if (!this.riskManager.canOpenPosition(preparedOrder.quantity, context.ticker.price)) {
        logger.warn(
          {
            symbol: context.symbol,
            quantity: preparedOrder.quantity,
            requestedQuantity: rawQuantity,
            price: context.ticker.price,
          },
          'Skipping BUY because position would exceed exposure limits'
        );
        return;
      }

      const order = await this.orderExecutor.executeOrder({
        symbol: preparedOrder.symbol,
        side: preparedOrder.side,
        type: preparedOrder.type,
        quantity: preparedOrder.quantity,
        price: preparedOrder.price,
        stopPrice: preparedOrder.stopPrice,
        status: preparedOrder.status,
      });

      logger.info({ order }, 'Order executed');
      this.riskManager.openPosition(
        order.symbol,
        order.quantity,
        order.averagePrice ?? context.ticker.price
      );

      this.journal.recordEntry({
        id: order.id!,
        symbol: context.symbol,
        entryTime: order.timestamp,
        entryPrice: order.averagePrice ?? context.ticker.price,
        quantity: order.quantity,
        side: 'BUY',
        strategyName: context.selectedBuySignal.strategyName,
        reason: context.selectedBuySignal.reasoning,
        notes: `Confidence: ${context.selectedBuySignal.confidence.toFixed(2)}`,
      });
      this.lastJournalUpdatedAt = order.timestamp;
      this.openTrades.set(context.symbol, {
        tradeId: order.id!,
        entryAtr: context.atr,
      });
      await this.persistState(`position opened for ${context.symbol}`);
      this.logRiskMetrics(`Risk metrics after opening position for ${context.symbol}`);
      return;
    }

    logger.info(
      {
        ...entryContext,
        action: context.selectedBuySignal?.action ?? 'HOLD',
        confidence: context.selectedBuySignal?.confidence ?? 0,
        topHoldReason:
          context.strategySignals
            .filter((signal) => signal.action === 'HOLD')
            .sort((left, right) => right.confidence - left.confidence)[0]?.reasoning ?? null,
      },
      'No entry executed this cycle'
    );
  }

  async runContinuous(intervalMs: number = 60000): Promise<void> {
    if (this.loopTimer) {
      throw new Error('Continuous trading loop is already running');
    }

    this.loopIntervalMs = intervalMs;
    this.state = 'idle';
    logger.info(
      { intervalMs },
      'Starting continuous trading system (interval in ms)'
    );

    await this.runCycleWithLock();

    this.loopTimer = setInterval(() => {
      void this.runCycleWithLock();
    }, intervalMs);

    // Never exit
    await new Promise(() => {});
  }

  async pauseTrading(): Promise<void> {
    if (this.state === 'paused') {
      return;
    }

    this.state = 'paused';
    this.pauseReason = 'Manual operator pause';
    this.stateUpdatedAt = Date.now();
    logger.warn({ symbols: this.symbols }, 'Trading paused');
    await this.persistState('manual pause');
  }

  async resumeTrading(): Promise<void> {
    if (this.state !== 'paused') {
      return;
    }

    this.state = 'idle';
    this.pauseReason = null;
    this.stateUpdatedAt = Date.now();
    logger.warn({ symbols: this.symbols }, 'Trading resumed');
    await this.persistState('manual resume');
  }

  async closeOpenPosition(
    reason: string = 'Manual close requested',
    symbol?: string
  ): Promise<boolean> {
    const targetSymbol = symbol ? normalizeSymbol(symbol) : this.riskManager.getAllPositions()[0]?.symbol;
    if (!targetSymbol) {
      return false;
    }

    const position = this.riskManager.getPosition(targetSymbol);
    if (!position) {
      return false;
    }

    const ticker = await this.marketDataProvider.getTicker(targetSymbol);
    await this.closePosition(targetSymbol, ticker.price, reason);
    return true;
  }

  getStatus(): TradingSystemStatus {
    return {
      symbol: this.symbols[0] ?? '',
      symbols: [...this.symbols],
      state: this.state,
      isCycleRunning: this.cyclePromise !== null,
      cycleIntervalMs: this.loopIntervalMs,
      lastCycleStartedAt: this.lastCycleStartedAt,
      lastCycleCompletedAt: this.lastCycleCompletedAt,
      lastCycleError: this.lastCycleError,
      entrySignalThreshold: this.entrySignalThreshold,
      openPosition: this.riskManager.getPosition(this.symbols[0] ?? ''),
      openPositions: this.riskManager.getAllPositions(),
      riskMetrics: this.riskManager.getRiskMetrics(),
      journalStats: this.journal.calculateStats(),
      openOrders: this.orderExecutor.getOpenOrders(),
      dryRun: this.dryRun,
    };
  }

  getOperatorStatus(): OperatorStatusPayload {
    const now = Date.now();
    const baseStatus = this.getStatus();
    const riskBlockers = this.getRiskBlockers();
    const openOrders = this.orderExecutor.getAllOrders()
      .filter((order) => order.status === 'OPEN' || order.status === 'PENDING')
      .map((order) => {
        const ageMs = Math.max(0, now - order.timestamp);
        return {
          id: order.id,
          symbol: order.symbol,
          side: order.side,
          type: order.type,
          status: order.status,
          price: order.price,
          quantity: order.quantity,
          timestamp: order.timestamp,
          ageMs,
          stale: ageMs > TradingSystem.staleOpenOrderThresholdMs,
        };
      });
    const staleOpenOrders = openOrders.filter((order) => order.stale);
    const trades = this.journal.getAllTrades();
    const closedTrades = trades.filter((trade) => trade.exitTime !== undefined);
    const riskState = this.riskManager.getState();
    const perSymbolExposure = baseStatus.openPositions.map((position) =>
      this.buildExposureView(position.symbol, position.quantity, position.entryPrice, position.currentPrice)
    );
    const operatorState = this.getOperatorState(
      baseStatus,
      staleOpenOrders.length > 0,
      riskBlockers.length > 0
    );
    const severity = this.getSeverity(baseStatus, staleOpenOrders.length > 0);
    const recommendation = this.getRecommendedAction(
      baseStatus,
      operatorState.reasonCode,
      severity,
      staleOpenOrders.length > 0
    );

    return {
      ...baseStatus,
      observedAt: now,
      timestamps: {
        processStartedAt: this.startedAt,
        stateUpdatedAt: this.stateUpdatedAt,
        lastCycleStartedAt: this.lastCycleStartedAt,
        lastCycleCompletedAt: this.lastCycleCompletedAt,
        lastSuccessfulCycleAt: this.lastSuccessfulCycleAt,
        accountSnapshotAt: this.lastAccountSnapshotAt,
        journalUpdatedAt: this.lastJournalUpdatedAt,
        statusGeneratedAt: now,
      },
      freshness: {
        cycleAgeMs:
          this.lastCycleCompletedAt !== null ? Math.max(0, now - this.lastCycleCompletedAt) : null,
        lastSuccessfulCycleAgeMs:
          this.lastSuccessfulCycleAt !== null ? Math.max(0, now - this.lastSuccessfulCycleAt) : null,
        accountSnapshotAgeMs:
          this.lastAccountSnapshotAt !== null ? Math.max(0, now - this.lastAccountSnapshotAt) : null,
        journalAgeMs:
          this.lastJournalUpdatedAt !== null ? Math.max(0, now - this.lastJournalUpdatedAt) : null,
      },
      operatorState,
      severity,
      recommendedAction: recommendation.action,
      recommendedActionReason: recommendation.reason,
      controls: {
        pauseAvailable: this.state !== 'paused',
        resumeAvailable: this.state === 'paused',
        closePositionAvailable: baseStatus.openPositions.length > 0,
        killSwitchAvailable: false,
      },
      riskVisibility: {
        totalExposure: baseStatus.riskMetrics.totalExposure,
        perSymbolExposure,
        rollingDrawdown: {
          current: baseStatus.riskMetrics.drawdown,
          percent: baseStatus.riskMetrics.drawdownPercent,
          peakEquity: riskState.peakEquity,
        },
        lossStreak: {
          current: this.calculateCurrentLossStreak(closedTrades),
          worstRecent: this.calculateWorstRecentLossStreak(closedTrades, 20),
        },
      },
      openOrderVisibility: {
        totalOpenOrders: openOrders.length,
        staleThresholdMs: TradingSystem.staleOpenOrderThresholdMs,
        staleOpenOrders: staleOpenOrders.map((order) => ({ ...order })),
        orders: openOrders,
      },
      performance: {
        feeAware: false,
        averageHoldingTimeMs: this.calculateAverageHoldingTimeMs(closedTrades),
        rollingPnL: {
          last24h: this.calculateRollingPnl(closedTrades, now - 24 * 60 * 60 * 1000),
          last7d: this.calculateRollingPnl(closedTrades, now - 7 * 24 * 60 * 60 * 1000),
          last30d: this.calculateRollingPnl(closedTrades, now - 30 * 24 * 60 * 60 * 1000),
        },
        symbolSummary: this.buildSymbolPerformanceSummary(closedTrades),
      },
      failures: {
        countsByType: { ...this.failureCounts },
        lastError: this.lastError ? { ...this.lastError } : null,
      },
      reconciliation: {
        orders: {
          ...this.lastOrderNormalization,
          touchedOrderIds: [...this.lastOrderNormalization.touchedOrderIds],
        },
      },
    };
  }

  getHealthStatus(authRequired: boolean): OperatorHealthPayload {
    return {
      ok: true,
      service: 'binance-trader',
      time: Date.now(),
      uptimeMs: Math.floor(process.uptime() * 1000),
      state: this.state,
      isCycleRunning: this.cyclePromise !== null,
      authRequired,
      status: this.getStatus(),
      deprecated: {
        statusInHealth: true,
        statusEndpoint: '/status',
      },
    };
  }

  private buildExposureView(
    symbol: string,
    quantity: number,
    entryPrice: number,
    currentPrice: number
  ): OperatorStatusPayload['riskVisibility']['perSymbolExposure'][number] {
    const tradeState = this.openTrades.get(symbol);
    const trade = tradeState ? this.journal.getTrade(tradeState.tradeId) : undefined;
    const holdingTimeMs = trade ? Math.max(0, Date.now() - trade.entryTime) : null;
    const unrealizedPnL = (currentPrice - entryPrice) * quantity;
    const unrealizedPnLPercent = entryPrice > 0 ? ((currentPrice - entryPrice) / entryPrice) * 100 : 0;
    const stopPrice = tradeState ? entryPrice - tradeState.entryAtr * this.stopLossAtrMultiple : null;
    const takeProfitPrice = tradeState ? entryPrice + tradeState.entryAtr * this.takeProfitAtrMultiple : null;

    return {
      symbol,
      quantity,
      notional: quantity * currentPrice,
      unrealizedPnL,
      unrealizedPnLPercent,
      holdingTimeMs,
      protectiveState: {
        active: Boolean(tradeState && tradeState.entryAtr > 0),
        mode: tradeState && tradeState.entryAtr > 0 ? 'bot-managed-atr-stop' : 'none',
        stopPrice,
        takeProfitPrice,
      },
    };
  }

  private getRiskBlockers(): string[] {
    const metrics = this.riskManager.getRiskMetrics();
    const riskState = this.riskManager.getState();
    const riskConfig = this.riskManager.getConfig();
    const dailyLoss = Math.max(0, -riskState.dailyRealizedPnL);
    const dailyLossPercent =
      riskState.peakEquity > 0 ? (dailyLoss / riskState.peakEquity) * 100 : 0;
    const blockers: string[] = [];

    if (metrics.drawdownPercent > riskConfig.maxDrawdownPercent) {
      blockers.push(
        `Drawdown ${metrics.drawdownPercent.toFixed(2)}% exceeds limit ${riskConfig.maxDrawdownPercent.toFixed(2)}%`
      );
    }

    if (dailyLoss > riskConfig.dailyLossLimit) {
      blockers.push(
        `Daily loss ${dailyLoss.toFixed(2)} exceeds limit ${riskConfig.dailyLossLimit.toFixed(2)}`
      );
    }

    if (dailyLossPercent > riskConfig.maxDailyLossPercent) {
      blockers.push(
        `Daily loss ${dailyLossPercent.toFixed(2)}% exceeds limit ${riskConfig.maxDailyLossPercent.toFixed(2)}%`
      );
    }

    return blockers;
  }

  private getOperatorState(
    status: TradingSystemStatus,
    hasStaleOpenOrders: boolean,
    riskBlocked: boolean
  ): OperatorStatusPayload['operatorState'] {
    if (status.state === 'paused') {
      return {
        mode: 'paused',
        reasonCode: 'paused-manual',
        reason: this.pauseReason ?? 'Trading paused by operator',
      };
    }

    if (status.isCycleRunning) {
      return {
        mode: 'active',
        reasonCode: 'running-cycle',
        reason: 'Trading cycle is currently executing',
      };
    }

    if (riskBlocked) {
      return {
        mode: 'idle',
        reasonCode: 'risk-blocked',
        reason: 'Risk limits currently block new entries',
      };
    }

    if (status.lastCycleError) {
      return {
        mode: 'idle',
        reasonCode: 'cycle-error',
        reason: 'Most recent trading cycle failed',
      };
    }

    if (hasStaleOpenOrders) {
      return {
        mode: 'idle',
        reasonCode: 'stale-open-orders',
        reason: 'Open or pending orders have exceeded the expected freshness window',
      };
    }

    if (status.openPositions.length > 0) {
      return {
        mode: 'idle',
        reasonCode: 'position-open',
        reason: 'Bot is supervising an open position',
      };
    }

    return {
      mode: 'idle',
      reasonCode: 'awaiting-next-cycle',
      reason: 'Bot is waiting for the next scheduled trading cycle',
    };
  }

  private getSeverity(
    status: TradingSystemStatus,
    hasStaleOpenOrders: boolean
  ): StatusSeverity {
    const riskBlockers = this.getRiskBlockers();

    if (status.lastCycleError || riskBlockers.length > 0) {
      return 'critical';
    }

    if (hasStaleOpenOrders || status.state === 'paused' || status.openPositions.length > 0) {
      return 'warning';
    }

    return 'ok';
  }

  private getRecommendedAction(
    status: TradingSystemStatus,
    reasonCode: OperatorStateCode,
    severity: StatusSeverity,
    hasStaleOpenOrders: boolean
  ): { action: RecommendedAction; reason: string } {
    if (reasonCode === 'paused-manual') {
      const blockers = this.getRiskBlockers();
      if (blockers.length === 0) {
        return {
          action: 'resume',
          reason: 'Bot is manually paused and no current risk blocker prevents resuming',
        };
      }

      return {
        action: 'none',
        reason: `Bot is paused and resume is blocked: ${blockers.join('; ')}`,
      };
    }

    if (severity === 'critical' && status.openPositions.length > 0) {
      return {
        action: 'close-position',
        reason: 'Critical state detected while a live position remains open',
      };
    }

    if (severity === 'critical') {
      return {
        action: 'pause',
        reason: 'Critical operator state detected; stop new cycles until reviewed',
      };
    }

    if (hasStaleOpenOrders) {
      return {
        action: 'pause',
        reason: 'Pending or open orders appear stale and should be reviewed before new actions',
      };
    }

    if (status.openPositions.length > 0) {
      return {
        action: 'none',
        reason: 'Bot is managing an open position within expected bounds',
      };
    }

    return {
      action: 'none',
      reason: 'No operator intervention is currently recommended',
    };
  }

  private calculateCurrentLossStreak(trades: Array<{ pnl?: number }>): number {
    let streak = 0;

    for (let index = trades.length - 1; index >= 0; index -= 1) {
      const pnl = trades[index].pnl ?? 0;
      if (pnl < 0) {
        streak += 1;
        continue;
      }
      break;
    }

    return streak;
  }

  private calculateWorstRecentLossStreak(
    trades: Array<{ pnl?: number }>,
    lookback: number
  ): number {
    let current = 0;
    let worst = 0;

    for (const trade of trades.slice(-lookback)) {
      const pnl = trade.pnl ?? 0;
      if (pnl < 0) {
        current += 1;
        worst = Math.max(worst, current);
      } else {
        current = 0;
      }
    }

    return worst;
  }

  private calculateAverageHoldingTimeMs(
    trades: Array<{ entryTime: number; exitTime?: number }>
  ): number | null {
    const durations = trades
      .map((trade) => (trade.exitTime !== undefined ? trade.exitTime - trade.entryTime : null))
      .filter((duration): duration is number => duration !== null && duration >= 0);

    if (durations.length === 0) {
      return null;
    }

    return durations.reduce((sum, duration) => sum + duration, 0) / durations.length;
  }

  private calculateRollingPnl(
    trades: Array<{ exitTime?: number; pnl?: number }>,
    since: number
  ): number {
    return trades.reduce((sum, trade) => {
      if (trade.exitTime === undefined || trade.exitTime < since) {
        return sum;
      }

      return sum + (trade.pnl ?? 0);
    }, 0);
  }

  private buildSymbolPerformanceSummary(
    trades: Array<{
      symbol: string;
      pnl?: number;
      entryTime: number;
      exitTime?: number;
    }>
  ): OperatorStatusPayload['performance']['symbolSummary'] {
    const symbols = Array.from(new Set(trades.map((trade) => trade.symbol)));

    return symbols.map((symbol) => {
      const symbolTrades = trades.filter((trade) => trade.symbol === symbol);
      const wins = symbolTrades.filter((trade) => (trade.pnl ?? 0) > 0).length;

      return {
        symbol,
        trades: symbolTrades.length,
        winRate: symbolTrades.length > 0 ? (wins / symbolTrades.length) * 100 : 0,
        totalPnL: symbolTrades.reduce((sum, trade) => sum + (trade.pnl ?? 0), 0),
        averageHoldingTimeMs: this.calculateAverageHoldingTimeMs(symbolTrades),
      };
    });
  }

  private normalizeLocalOrderState(reason: string): void {
    const trades = this.journal.getAllTrades();
    const result = this.orderExecutor.normalizeOrderState({
      now: Date.now(),
      knownEntryOrderIds: new Set(
        trades
          .map((trade) => trade.id)
          .filter((tradeId) => !String(tradeId).startsWith('RESTORED_'))
      ),
      symbolsWithOpenPositions: new Set(
        this.riskManager.getAllPositions().map((position) => position.symbol)
      ),
      latestExitTimeBySymbol: trades.reduce((latest, trade) => {
        if (trade.exitTime !== undefined) {
          latest.set(
            trade.symbol,
            Math.max(latest.get(trade.symbol) ?? 0, trade.exitTime)
          );
        }
        return latest;
      }, new Map<string, number>()),
    });

    this.lastOrderNormalization = {
      ...result,
      touchedOrderIds: [...result.touchedOrderIds],
      lastReason: reason,
      cumulativeReclassifiedFilled:
        this.lastOrderNormalization.cumulativeReclassifiedFilled + result.reclassifiedFilled,
      cumulativeReclassifiedFailed:
        this.lastOrderNormalization.cumulativeReclassifiedFailed + result.reclassifiedFailed,
    };

    if (result.reclassifiedFilled > 0 || result.reclassifiedFailed > 0) {
      logger.warn(
        {
          reason,
          reclassifiedFilled: result.reclassifiedFilled,
          reclassifiedFailed: result.reclassifiedFailed,
          touchedOrderIds: result.touchedOrderIds,
        },
        'Normalized stale local market-order state'
      );
    }

    if (result.unresolvedStaleOrders > 0) {
      this.recordFailure(
        'order-reconciliation',
        new Error(
          `Unresolved stale local orders remain after ${reason}: ${result.unresolvedStaleOrders}`
        )
      );
    }
  }

  private recordFailure(source: string, error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    const type = this.classifyFailure(message, source);
    this.failureCounts[type] += 1;
    this.lastError = {
      type,
      source,
      message,
      occurredAt: Date.now(),
    };
  }

  private classifyFailure(message: string, source: string): FailureType {
    const haystack = `${source} ${message}`.toLowerCase();

    if (haystack.includes('candle') || haystack.includes('ticker') || haystack.includes('market')) {
      return 'market-data';
    }

    if (
      haystack.includes('binance') ||
      haystack.includes('exchange') ||
      haystack.includes('account')
    ) {
      return 'exchange';
    }

    if (
      haystack.includes('reconcile') ||
      haystack.includes('reconciliation') ||
      haystack.includes('stale local orders')
    ) {
      return 'reconciliation';
    }

    if (
      haystack.includes('order') ||
      haystack.includes('pending') ||
      haystack.includes('filled') ||
      haystack.includes('cancelled')
    ) {
      return 'order-lifecycle';
    }

    if (haystack.includes('risk') || haystack.includes('drawdown') || haystack.includes('loss')) {
      return 'risk';
    }

    if (haystack.includes('invalid') || haystack.includes('missing') || haystack.includes('unsupported')) {
      return 'validation';
    }

    if (haystack.includes('state') || haystack.includes('persist') || haystack.includes('restore')) {
      return 'state';
    }

    if (haystack.includes('manual') || haystack.includes('operator') || haystack.includes('control')) {
      return 'operator';
    }

    return 'unknown';
  }

  getJournal(): TradeJournal {
    return this.journal;
  }

  getOrderExecutor(): OrderExecutor {
    return this.orderExecutor;
  }

  getRiskManager(): RiskManager {
    return this.riskManager;
  }

  async restoreFromState(
    state: PersistedTradingState | LegacyPersistedTradingState | null
  ): Promise<void> {
    if (state) {
      const persistedSymbols = 'symbols' in state ? state.symbols : [state.symbol];
      const normalizedPersistedSymbols = persistedSymbols.map((symbol) => normalizeSymbol(symbol));
      const missingSymbols = normalizedPersistedSymbols.filter(
        (symbol) => !this.symbols.includes(symbol)
      );

      if (missingSymbols.length > 0) {
        logger.warn(
          { persistedSymbols: normalizedPersistedSymbols, currentSymbols: this.symbols, missingSymbols },
          'Persisted state includes symbols not present in current config'
        );
      }

      this.journal.restoreTrades(state.journal);
      this.lastJournalUpdatedAt =
        state.journal.reduce((latest, trade) => {
          const candidate = trade.exitTime ?? trade.entryTime;
          return Math.max(latest, candidate);
        }, 0) || null;
      this.orderExecutor.restoreOrders(state.orders);
      this.riskManager.restoreState(state.risk);
      this.openTrades = new Map(
        state.openTrades
          .filter((trade) => this.symbols.includes(normalizeSymbol(trade.symbol)))
          .map((trade) => [
            normalizeSymbol(trade.symbol),
            { tradeId: trade.tradeId, entryAtr: trade.entryAtr },
          ])
      );
      this.loopIntervalMs = state.runtime.cycleIntervalMs;
      this.lastCycleStartedAt = state.runtime.lastCycleStartedAt;
      this.lastCycleCompletedAt = state.runtime.lastCycleCompletedAt;
      this.lastSuccessfulCycleAt = state.runtime.lastCycleCompletedAt;
      this.lastCycleError = state.runtime.lastCycleError;
      this.state = state.runtime.state === 'paused' ? 'paused' : 'idle';
      this.pauseReason = this.state === 'paused' ? 'Restored paused state from persisted runtime' : null;
      this.stateUpdatedAt = Date.now();
      this.normalizeLocalOrderState('restored persisted state');

      logger.info(
        {
          filePath: this.stateStore.getFilePath(),
          paused: this.state === 'paused',
          openTradeCount: this.openTrades.size,
          restoredSymbols: normalizedPersistedSymbols,
        },
        'Persisted trading state restored'
      );
    }

    await this.reconcileWithExchange();
    this.normalizeLocalOrderState('startup reconciliation');
    await this.persistState('startup reconciliation');
  }

  private async runCycleWithLock(): Promise<void> {
    if (this.cyclePromise) {
      logger.warn({ symbols: this.symbols }, 'Skipping cycle because previous cycle is still running');
      return;
    }

    this.lastCycleStartedAt = Date.now();
    this.lastCycleError = null;
    this.state = 'running';
    this.stateUpdatedAt = this.lastCycleStartedAt;

    const cycle = this.runCycle();
    this.cyclePromise = cycle;

    try {
      await cycle;
      this.lastCycleCompletedAt = Date.now();
      this.lastSuccessfulCycleAt = this.lastCycleCompletedAt;
    } catch (error) {
      this.lastCycleCompletedAt = Date.now();
      this.lastCycleError =
        error instanceof Error ? error.message : 'Unknown cycle error';
      this.recordFailure('cycle', error);
      logger.error({ error }, 'Managed cycle failed');
    } finally {
      this.cyclePromise = null;
      if (this.state === 'running') {
        this.state = 'idle';
        this.stateUpdatedAt = Date.now();
      }
      await this.persistState('cycle completion');
    }
  }

  private getExitReason(
    symbol: string,
    entryPrice: number,
    currentPrice: number,
    signalAction: 'BUY' | 'SELL' | 'HOLD',
    strategyName?: string
  ): string | null {
    const openTradeState = this.openTrades.get(symbol);
    const openTrade = openTradeState
      ? this.journal.getTrade(openTradeState.tradeId)
      : undefined;
    const atr = openTradeState?.entryAtr ?? 0;
    const stopPrice = entryPrice - atr * this.stopLossAtrMultiple;
    const takeProfitPrice = entryPrice + atr * this.takeProfitAtrMultiple;
    const priceChangePercent = ((currentPrice - entryPrice) / entryPrice) * 100;

    if (atr > 0 && currentPrice <= stopPrice) {
      return `ATR stop loss triggered at ${priceChangePercent.toFixed(2)}%`;
    }

    if (atr > 0 && currentPrice >= takeProfitPrice) {
      return `ATR take profit triggered at ${priceChangePercent.toFixed(2)}%`;
    }

    if (signalAction === 'SELL') {
      return strategyName ? `Strategy exit signal from ${strategyName}` : 'Strategy exit signal';
    }

    if (openTrade && Date.now() - openTrade.entryTime >= this.maxHoldTimeMs) {
      return `Max hold time reached after ${(this.maxHoldTimeMs / 60000).toFixed(0)} minutes`;
    }

    return null;
  }

  private async closePosition(symbol: string, currentPrice: number, reason: string): Promise<void> {
    const position = this.riskManager.getPosition(symbol);
    if (!position) {
      return;
    }

    const baseAsset = this.baseAssets[symbol];
    const baseAssetBalance = baseAsset
      ? await this.orderExecutor.getAssetBalance(baseAsset)
      : null;
    const freeBaseQuantity = Math.max(baseAssetBalance?.free ?? 0, 0);
    const exitQuantity =
      freeBaseQuantity > 0
        ? Math.min(position.quantity, freeBaseQuantity)
        : position.quantity;

    if (exitQuantity <= 0) {
      logger.warn(
        {
          symbol,
          baseAsset,
          positionQuantity: position.quantity,
          freeBaseQuantity,
          reason,
        },
        'Skipping exit because no free base-asset balance is available'
      );
      return;
    }

    const order = await this.orderExecutor.executeOrder({
      symbol,
      side: 'SELL',
      type: 'MARKET',
      quantity: exitQuantity,
      price: currentPrice,
      status: 'PENDING',
    });

    logger.info({ order, reason, symbol }, 'Exit order executed');
    this.riskManager.closePosition(symbol, order.averagePrice ?? currentPrice);

    const openTradeState = this.openTrades.get(symbol);
    if (openTradeState) {
      this.journal.recordExit(
        openTradeState.tradeId,
        order.averagePrice ?? currentPrice,
        order.timestamp
      );
      this.lastJournalUpdatedAt = order.timestamp;
      this.openTrades.delete(symbol);
    }

    await this.persistState(`position closed for ${symbol}: ${reason}`);
  }

  private logRiskMetrics(message: string): void {
    const riskMetrics = this.riskManager.getRiskMetrics();
    logger.info({ riskMetrics }, message);
  }

  private calculateOrderQuantity(price: number, stopDistance: number): number {
    const riskConfig = this.riskManager.getConfig();
    let maxNotional =
      this.riskManager.getAccountBalance() * (riskConfig.maxPositionSize / 100);
    const riskSizedQuantity =
      stopDistance > 0
        ? this.riskManager.calculatePositionSize(
            this.riskManager.getAccountBalance(),
            stopDistance
          )
        : maxNotional / price;

    if (!this.dryRun && this.liveMaxOrderNotional !== undefined) {
      maxNotional = Math.min(maxNotional, this.liveMaxOrderNotional);
    }

    const cappedQuantity = maxNotional / price;
    const quantity = Math.min(riskSizedQuantity, cappedQuantity);

    logger.info(
      {
        price,
        stopDistance,
        maxNotional,
        riskSizedQuantity,
        cappedQuantity,
        quantity,
        dryRun: this.dryRun,
        liveMaxOrderNotional: this.liveMaxOrderNotional,
      },
      'Calculated dynamic order quantity'
    );

    return quantity;
  }

  private buildStrategies(symbol: string, higherTimeframeCandles: CandleData[]): BaseStrategy[] {
    const strategyConfigs: StrategyConfig[] = this.strategyTemplates
      .filter((strategy) => strategy.enabled)
      .map((strategy) => ({
        type: strategy.type,
        name: strategy.name,
        symbol,
        enabled: strategy.enabled,
        parameters: {
          ...strategy.parameters,
          higherTimeframeCandles,
        },
      }));

    return strategyConfigs.map((config) => {
      switch (config.type) {
        case 'trend_pullback':
          return new TrendPullbackStrategy(config);
        case 'breakout_confirmation':
          return new BreakoutConfirmationStrategy(config);
        case 'mean_reversion_dip_buy':
          return new MeanReversionDipBuyStrategy(config);
        default:
          throw new Error(`Unsupported strategy configuration: ${config.type}`);
      }
    });
  }

  private selectBestCandidate(signals: StrategySignal[]): RankedStrategyCandidate | null {
    if (signals.length === 0) {
      return null;
    }

    const rankedSignals = signals
      .map((signal) => ({
        ...signal,
        rankScore: signal.confidence,
      }))
      .sort((left, right) => right.rankScore - left.rankScore);

    return rankedSignals[0];
  }

  private async reconcileWithExchange(): Promise<void> {
    const accountInfo = await this.orderExecutor.getAccountInfo();
    this.lastAccountSnapshotAt = accountInfo.updateTime || Date.now();
    const quoteBalance = this.getAssetQuantity(accountInfo, this.quoteAsset);
    this.riskManager.setAccountBalance(quoteBalance);

    for (const symbol of this.symbols) {
      const baseAsset = this.baseAssets[symbol];
      const baseBalance = this.getAssetQuantity(accountInfo, baseAsset);
      const ticker = await this.marketDataProvider.getTicker(symbol);
      const tradingRules = await this.orderExecutor.getSymbolTradingRules(symbol);
      const baseNotional = baseBalance * ticker.price;
      const localPosition = this.riskManager.getPosition(symbol);
      const openTradeState = this.openTrades.get(symbol);
      const openTrade = openTradeState
        ? this.journal.getTrade(openTradeState.tradeId)
        : undefined;

      if (baseBalance <= 0 || baseNotional < tradingRules.minNotional) {
        if (localPosition) {
          logger.warn(
            {
              symbol,
              baseAsset,
              baseBalance,
              baseNotional,
              minNotional: tradingRules.minNotional,
            },
            'Clearing local position because Binance reports only non-tradable base-asset dust'
          );
          this.riskManager.removePosition(symbol);
          this.openTrades.delete(symbol);
        }
        continue;
      }

      const entryPrice = openTrade?.entryPrice ?? localPosition?.entryPrice ?? ticker.price;
      const restoredPosition = this.buildPosition(symbol, baseBalance, entryPrice, ticker.price);

      if (!localPosition) {
        this.riskManager.upsertPosition(restoredPosition);

        if (!openTradeState) {
          const syntheticTradeId = `RESTORED_${symbol}_${Date.now()}`;
          this.journal.recordEntry({
            id: syntheticTradeId,
            symbol,
            entryTime: Date.now(),
            entryPrice,
            quantity: baseBalance,
            side: 'BUY',
            strategyName: 'State Reconciliation',
            reason: 'Reconstructed from exchange balances',
            notes: 'Recovered open position on startup',
          });
          this.openTrades.set(symbol, {
            tradeId: syntheticTradeId,
            entryAtr: 0,
          });
        }

        logger.warn(
          { symbol, quantity: baseBalance, entryPrice },
          'Rebuilt missing local position from Binance balances'
        );
        continue;
      }

      this.riskManager.upsertPosition({
        ...restoredPosition,
        entryPrice: openTrade?.entryPrice ?? localPosition.entryPrice,
      });

      logger.info(
        {
          symbol,
          exchangeQuantity: baseBalance,
          localQuantity: localPosition.quantity,
        },
        'Reconciled local position with Binance balances'
      );
    }

    this.normalizeLocalOrderState('exchange reconciliation');
  }

  private buildPosition(
    symbol: string,
    quantity: number,
    entryPrice: number,
    currentPrice: number
  ): Position {
    const unrealizedPnL = (currentPrice - entryPrice) * quantity;
    const unrealizedPnLPercent =
      entryPrice > 0 ? ((currentPrice - entryPrice) / entryPrice) * 100 : 0;

    return {
      symbol,
      quantity,
      entryPrice,
      currentPrice,
      unrealizedPnL,
      unrealizedPnLPercent,
    };
  }

  private getAssetQuantity(accountInfo: AccountInfo, asset: string): number {
    const balance = accountInfo.balances.find(
      (entry) => entry.asset.toUpperCase() === asset.toUpperCase()
    );

    return (balance?.free ?? 0) + (balance?.locked ?? 0);
  }

  private async persistState(reason: string): Promise<void> {
    const state: PersistedTradingState = {
      version: 2,
      savedAt: Date.now(),
      symbols: [...this.symbols],
      runtime: {
        state: this.state === 'paused' ? 'paused' : 'idle',
        cycleIntervalMs: this.loopIntervalMs,
        lastCycleStartedAt: this.lastCycleStartedAt,
        lastCycleCompletedAt: this.lastCycleCompletedAt,
        lastCycleError: this.lastCycleError,
      },
      openTrades: Array.from(this.openTrades.entries()).map(([symbol, trade]) => ({
        symbol,
        tradeId: trade.tradeId,
        entryAtr: trade.entryAtr,
      })),
      risk: this.riskManager.getState(),
      journal: this.journal.getAllTrades().map((trade) => ({ ...trade })),
      orders: this.orderExecutor.getAllOrders().map((order) => ({ ...order })),
    };

    await this.stateStore.save(state);
    logger.info({ filePath: this.stateStore.getFilePath(), reason }, 'Persisted trading state');
  }

  private calculateATR(candles: CandleData[], period: number): number {
    if (candles.length < period + 1) {
      return 0;
    }

    const trueRanges: number[] = [];
    for (let i = 1; i < candles.length; i++) {
      const current = candles[i];
      const previous = candles[i - 1];
      trueRanges.push(
        Math.max(
          current.high - current.low,
          Math.abs(current.high - previous.close),
          Math.abs(current.low - previous.close)
        )
      );
    }

    const recentTrueRanges = trueRanges.slice(-period);
    return (
      recentTrueRanges.reduce((sum, value) => sum + value, 0) /
      recentTrueRanges.length
    );
  }
}

class ControlServer {
  private readonly system: TradingSystem;
  private readonly config: ControlServerConfig;
  private server: http.Server | null = null;

  constructor(system: TradingSystem, config: ControlServerConfig) {
    this.system = system;
    this.config = config;
  }

  async start(): Promise<void> {
    if (this.server) {
      return;
    }

    this.server = http.createServer((req, res) => {
      void this.handleRequest(req, res);
    });

    await new Promise<void>((resolve, reject) => {
      this.server!.once('error', reject);
      this.server!.listen(this.config.port, this.config.host, () => {
        this.server!.off('error', reject);
        resolve();
      });
    });

    logger.info(
      { host: this.config.host, port: this.config.port },
      'Control server started'
    );
  }

  private async handleRequest(
    req: IncomingMessage,
    res: ServerResponse
  ): Promise<void> {
    try {
      const method = req.method || 'GET';
      const url = new URL(req.url || '/', 'http://localhost');

      if (method === 'GET' && url.pathname === '/health') {
        this.sendJson(res, 200, this.system.getHealthStatus(Boolean(this.config.authToken)));
        return;
      }

      if (!this.isAuthorized(req)) {
        this.sendJson(res, 401, { error: 'Unauthorized' });
        return;
      }

      if (method === 'GET' && url.pathname === '/status') {
        this.sendJson(res, 200, this.system.getOperatorStatus());
        return;
      }

      if (method === 'POST' && url.pathname === '/pause') {
        await this.system.pauseTrading();
        this.sendJson(res, 200, this.system.getOperatorStatus());
        return;
      }

      if (method === 'POST' && url.pathname === '/resume') {
        await this.system.resumeTrading();
        this.sendJson(res, 200, this.system.getOperatorStatus());
        return;
      }

      if (method === 'POST' && url.pathname === '/close-position') {
        const body = await this.readJsonBody(req);
        const closed = await this.system.closeOpenPosition(
          typeof body.reason === 'string' && body.reason.trim().length > 0
            ? body.reason
            : 'Manual close requested',
          typeof body.symbol === 'string' && body.symbol.trim().length > 0
            ? body.symbol
            : undefined
        );
        this.sendJson(res, 200, {
          closed,
          status: this.system.getOperatorStatus(),
        });
        return;
      }

      this.sendJson(res, 404, { error: 'Not found' });
    } catch (error) {
      logger.error({ error }, 'Control server request failed');
      this.sendJson(res, 500, {
        error: error instanceof Error ? error.message : 'Internal server error',
      });
    }
  }

  private isAuthorized(req: IncomingMessage): boolean {
    if (!this.config.authToken) {
      return true;
    }

    const header = req.headers.authorization;
    return header === `Bearer ${this.config.authToken}`;
  }

  private async readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
    const chunks: Buffer[] = [];

    for await (const chunk of req) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }

    if (chunks.length === 0) {
      return {};
    }

    const rawBody = Buffer.concat(chunks).toString('utf8').trim();
    if (!rawBody) {
      return {};
    }

    return JSON.parse(rawBody) as Record<string, unknown>;
  }

  private sendJson(
    res: ServerResponse,
    statusCode: number,
    payload: unknown
  ): void {
    res.statusCode = statusCode;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify(payload));
  }
}

function getBinanceEnvironment(): BinanceEnvironment {
  const rawValue = (process.env.BINANCE_ENV || 'testnet').toLowerCase();

  if (rawValue === 'live' || rawValue === 'production') {
    return 'live';
  }

  if (rawValue === 'testnet') {
    return 'testnet';
  }

  throw new Error(
    `Invalid BINANCE_ENV value "${process.env.BINANCE_ENV}". Expected "testnet" or "live".`
  );
}

function getDryRunMode(): boolean {
  const rawValue = (process.env.DRY_RUN || 'true').toLowerCase();

  if (rawValue === 'true') {
    return true;
  }

  if (rawValue === 'false') {
    return false;
  }

  throw new Error(
    `Invalid DRY_RUN value "${process.env.DRY_RUN}". Expected "true" or "false".`
  );
}

function getControlServerConfig(): ControlServerConfig {
  const host = process.env.CONTROL_API_HOST || '127.0.0.1';
  const rawPort = process.env.CONTROL_API_PORT || '3001';
  const port = Number(rawPort);

  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(
      `Invalid CONTROL_API_PORT value "${process.env.CONTROL_API_PORT}". Expected a TCP port number.`
    );
  }

  const authToken = process.env.CONTROL_API_TOKEN?.trim() || undefined;

  return {
    host,
    port,
    authToken,
  };
}

function getStateFilePath(): string {
  const rawValue = process.env.BOT_STATE_FILE?.trim();
  return rawValue ? path.resolve(rawValue) : path.resolve(process.cwd(), 'data', 'bot-state.json');
}

function getLiveMaxOrderNotional(): number | undefined {
  const rawValue = process.env.MAX_LIVE_ORDER_NOTIONAL?.trim();

  if (!rawValue) {
    return undefined;
  }

  const parsed = Number(rawValue);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(
      `Invalid MAX_LIVE_ORDER_NOTIONAL value "${process.env.MAX_LIVE_ORDER_NOTIONAL}". Expected a positive number.`
    );
  }

  return parsed;
}

// Main execution
async function main(): Promise<void> {
  const environment = getBinanceEnvironment();
  const isLive = environment === 'live';
  const dryRun = getDryRunMode();
  const botConfig = await loadBotConfig();
  const quoteAssets = Array.from(new Set(botConfig.symbols.map((symbol) => getQuoteAsset(symbol))));
  if (quoteAssets.length !== 1) {
    throw new Error(
      `All configured symbols must share the same quote asset. Found: ${quoteAssets.join(', ')}`
    );
  }

  const quoteAsset = quoteAssets[0];
  const baseAssets = Object.fromEntries(
    botConfig.symbols.map((symbol) => [symbol, getBaseAsset(symbol)])
  ) as Record<string, string>;
  const controlServerConfig = getControlServerConfig();
  const stateStore = new FileStateStore(getStateFilePath());
  const liveMaxOrderNotional = getLiveMaxOrderNotional();
  const persistedState = await stateStore.load();

  const executionConfig: ExecutionConfig = {
    apiKey: process.env.BINANCE_API_KEY || '',
    apiSecret: process.env.BINANCE_API_SECRET || '',
    testnet: !isLive,
    dryRun,
    baseURL: process.env.BINANCE_BASE_URL || undefined,
  };

  if (!executionConfig.apiKey || !executionConfig.apiSecret) {
    throw new Error('BINANCE_API_KEY and BINANCE_API_SECRET must be set');
  }

  const riskConfig: RiskConfig = {
    maxPositionSize: 5,
    maxDrawdownPercent: 10,
    stopLossPercent: 1,
    takeProfitPercent: 2.5,
    dailyLossLimit: 500,
    maxRiskPerTradePercent: 1,
    maxDailyLossPercent: 2,
  };

  const accountInfo: AccountInfo = await OrderExecutor.fetchAccountInfo(
    executionConfig
  );
  const balances = accountInfo.balances.filter(
    (balance: AccountBalance) =>
      (balance.free > 0 || balance.locked > 0)
  );
  const quoteAssetBalance =
    accountInfo.balances.find((balance) => balance.asset === quoteAsset)?.free ?? 0;

  if (quoteAssetBalance <= 0) {
    throw new Error(
      `No available ${quoteAsset} balance found for configured symbols ${botConfig.symbols.join(', ')}`
    );
  }

  logger.info(
    {
      environment,
      dryRun,
      symbols: botConfig.symbols,
      strategyNames: botConfig.strategies.filter((strategy) => strategy.enabled).map((strategy) => strategy.name),
      quoteAsset,
      baseAssets,
      configFile: getConfigFilePath(),
      stateFile: stateStore.getFilePath(),
      liveMaxOrderNotional,
      baseURL:
        executionConfig.baseURL ||
        (executionConfig.testnet
          ? 'https://testnet.binance.vision/api/v3'
          : 'https://api.binance.com/api/v3'),
      canTrade: accountInfo.canTrade,
      canWithdraw: accountInfo.canWithdraw,
      canDeposit: accountInfo.canDeposit,
      balances,
      quoteAssetBalance,
    },
    'Fetched Binance account balances'
  );

  const system = new TradingSystem(
    new MarketDataProvider(),
    executionConfig,
    riskConfig,
    persistedState?.risk.accountBalance ?? quoteAssetBalance,
    botConfig.symbols,
    {
      quoteAsset,
      baseAssets,
      stateStore,
      liveMaxOrderNotional,
      strategyTemplates: botConfig.strategies,
    }
  );

  await system.restoreFromState(persistedState);

  const controlServer = new ControlServer(system, controlServerConfig);
  await controlServer.start();

  // Run continuously with 60-second interval (adjust as needed)
  await system.runContinuous(60000);
}

const isDirectExecution =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectExecution) {
  main().catch((error) => {
    logger.error({ error }, 'Fatal error in main');
    process.exit(1);
  });
}

export { TradingSystem };
