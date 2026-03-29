import 'dotenv/config';
import http, { type IncomingMessage, type ServerResponse } from 'http';
import path from 'path';
import logger from './logger';
import {
  MarketDataProvider,
  type Ticker,
  type CandleData,
} from './marketData';
import {
  TrendPullbackStrategy,
  type StrategyConfig,
} from './strategy';
import {
  OrderExecutor,
  type ExecutionConfig,
  type AccountBalance,
  type AccountInfo,
} from './execution';
import { RiskManager, type RiskConfig, type Position } from './risk';
import { TradeJournal } from './journal';
import {
  FileStateStore,
  type PersistedTradingState,
} from './runtime/stateStore';

type BinanceEnvironment = 'testnet' | 'live';
type SystemState = 'idle' | 'running' | 'paused' | 'stopping';

type TradingSystemStatus = {
  symbol: string;
  state: SystemState;
  isCycleRunning: boolean;
  cycleIntervalMs: number | null;
  lastCycleStartedAt: number | null;
  lastCycleCompletedAt: number | null;
  lastCycleError: string | null;
  entrySignalThreshold: number;
  openPosition: ReturnType<RiskManager['getPosition']>;
  riskMetrics: ReturnType<RiskManager['getRiskMetrics']>;
  journalStats: ReturnType<TradeJournal['calculateStats']>;
  openOrders: ReturnType<OrderExecutor['getOpenOrders']>;
  dryRun: boolean | undefined;
};

type ControlServerConfig = {
  host: string;
  port: number;
  authToken?: string;
};

type TradingSystemOptions = {
  quoteAsset: string;
  baseAsset: string;
  stateStore: FileStateStore;
  liveMaxOrderNotional?: number;
};

function getTradingSymbol(): string {
  const symbol = (process.env.TRADING_SYMBOL || 'BTCUSDT').toUpperCase();

  if (!/^[A-Z0-9]+$/.test(symbol)) {
    throw new Error(`Invalid TRADING_SYMBOL value "${symbol}"`);
  }

  return symbol;
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

class TradingSystem {
  private marketDataProvider: MarketDataProvider;
  private orderExecutor: OrderExecutor;
  private riskManager: RiskManager;
  private journal: TradeJournal;
  private openTrades: Map<string, { tradeId: string; entryAtr: number }> = new Map();
  private readonly symbol: string;
  private readonly quoteAsset: string;
  private readonly baseAsset: string;
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
  private lastCycleStartedAt: number | null = null;
  private lastCycleCompletedAt: number | null = null;
  private lastCycleError: string | null = null;

  constructor(
    marketDataProvider: MarketDataProvider,
    executionConfig: ExecutionConfig,
    riskConfig: RiskConfig,
    initialBalance: number,
    symbol: string,
    options: TradingSystemOptions
  ) {
    this.marketDataProvider = marketDataProvider;
    this.orderExecutor = new OrderExecutor(executionConfig);
    this.riskManager = new RiskManager(riskConfig, initialBalance);
    this.journal = new TradeJournal();
    this.symbol = symbol;
    this.quoteAsset = options.quoteAsset;
    this.baseAsset = options.baseAsset;
    this.stateStore = options.stateStore;
    this.liveMaxOrderNotional = options.liveMaxOrderNotional;
    this.dryRun = executionConfig.dryRun;

    logger.info(
      {
        symbol,
        stateFile: this.stateStore.getFilePath(),
        liveMaxOrderNotional: this.liveMaxOrderNotional,
      },
      'Trading system initialized'
    );
  }

  async runCycle(): Promise<void> {
    if (this.state === 'paused') {
      logger.info({ symbol: this.symbol }, 'Skipping cycle because trading is paused');
      return;
    }

    try {
      // Fetch market data
      const ticker: Ticker = await this.marketDataProvider.getTicker(
        this.symbol
      );
      logger.info(
        { ticker },
        'Market data fetched successfully'
      );

      // Get candle data for strategy analysis
      const candles: CandleData[] = await this.marketDataProvider.getCandles(
        this.symbol,
        '1m',
        100
      );
      const higherTimeframeCandles: CandleData[] =
        await this.marketDataProvider.getCandles(
          this.symbol,
          '15m',
          240
      );
      logger.info(
        {
          candleCount: candles.length,
          higherTimeframeCandleCount: higherTimeframeCandles.length,
        },
        'Candle data retrieved'
      );

      // Create and run strategy
      const strategyConfig: StrategyConfig = {
        name: 'Trend Pullback Strategy',
        symbol: this.symbol,
        enabled: true,
        parameters: {
          fastPeriod: 5,
          pullbackPeriod: 20,
          trendPeriod: 200,
          pullbackTolerancePercent: 0.15,
          trendBufferPercent: 0.35,
          minTrendStrengthPercent: 0.03,
          higherTimeframeCandles,
        },
      };

      const strategy = new TrendPullbackStrategy(strategyConfig);
      strategy.updateCandles(candles);
      const signal = strategy.analyze();
      logger.info({ signal }, 'Strategy signal generated');
      const atr = this.calculateATR(candles, 14);
      const atrPercent = ticker.price > 0 ? (atr / ticker.price) * 100 : 0;
      const existingPosition = this.riskManager.getPosition(this.symbol);
      const entryContext = {
        symbol: this.symbol,
        price: ticker.price,
        atr,
        atrPercent,
        minAtrPercentForEntry: this.minAtrPercentForEntry,
        entrySignalThreshold: this.entrySignalThreshold,
        existingPosition: Boolean(existingPosition),
        diagnostics: signal.diagnostics,
      };

      this.logRiskMetrics('Risk metrics before trade evaluation');

      if (existingPosition) {
        this.riskManager.updatePositionPrice(this.symbol, ticker.price);

        const exitReason = this.getExitReason(
          existingPosition.entryPrice,
          ticker.price,
          signal.action
        );

        if (exitReason) {
          await this.closePosition(ticker.price, exitReason);
          this.logRiskMetrics('Risk metrics after closing position');
          const stats = this.journal.calculateStats();
          logger.info({ stats }, 'Trading cycle completed');
          return;
        }
      }

      // Order execution (simulated)
      if (signal.action === 'BUY' && signal.confidence >= this.entrySignalThreshold) {
        if (!this.riskManager.validateRisk()) {
          logger.warn(entryContext, 'Skipping BUY because portfolio risk limits are exceeded');
        } else if (atrPercent < this.minAtrPercentForEntry) {
          logger.info(
            entryContext,
            'Skipping BUY because volatility is too low for the pullback setup'
          );
        } else if (!existingPosition) {
          const rawQuantity = this.calculateOrderQuantity(
            ticker.price,
            atr * this.stopLossAtrMultiple
          );
          const preparedOrder = await this.orderExecutor.prepareOrder({
            symbol: this.symbol,
            side: 'BUY',
            type: 'MARKET',
            quantity: rawQuantity,
            price: ticker.price,
            status: 'PENDING',
          });

          if (!this.riskManager.canOpenPosition(preparedOrder.quantity, ticker.price)) {
            logger.warn(
              {
                symbol: this.symbol,
                quantity: preparedOrder.quantity,
                requestedQuantity: rawQuantity,
                price: ticker.price,
              },
              'Skipping BUY because position would exceed exposure limits'
            );
          } else {
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
              order.averagePrice ?? ticker.price
            );

            this.journal.recordEntry({
              id: order.id!,
              symbol: this.symbol,
              entryTime: order.timestamp,
              entryPrice: order.averagePrice ?? ticker.price,
              quantity: order.quantity,
              side: 'BUY',
              strategyName: strategy.getName(),
              reason: signal.reasoning,
              notes: `Confidence: ${signal.confidence.toFixed(2)}`,
            });
            this.openTrades.set(this.symbol, {
              tradeId: order.id!,
              entryAtr: atr,
            });
            await this.persistState('position opened');
            this.logRiskMetrics('Risk metrics after opening position');
          }
        } else {
          logger.info(
            entryContext,
            'Skipping BUY because a position is already open'
          );
        }
      } else {
        logger.info(
          {
            ...entryContext,
            action: signal.action,
            confidence: signal.confidence,
          },
          'No entry executed this cycle'
        );
      }

      // Display journal stats
      const stats = this.journal.calculateStats();
      logger.info({ stats }, 'Trading cycle completed');
    } catch (error) {
      logger.error({ error }, 'Error in trading cycle');
      throw error;
    }
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
    logger.warn({ symbol: this.symbol }, 'Trading paused');
    await this.persistState('manual pause');
  }

  async resumeTrading(): Promise<void> {
    if (this.state !== 'paused') {
      return;
    }

    this.state = 'idle';
    logger.warn({ symbol: this.symbol }, 'Trading resumed');
    await this.persistState('manual resume');
  }

  async closeOpenPosition(reason: string = 'Manual close requested'): Promise<boolean> {
    const position = this.riskManager.getPosition(this.symbol);
    if (!position) {
      return false;
    }

    const ticker = await this.marketDataProvider.getTicker(this.symbol);
    await this.closePosition(ticker.price, reason);
    return true;
  }

  getStatus(): TradingSystemStatus {
    return {
      symbol: this.symbol,
      state: this.state,
      isCycleRunning: this.cyclePromise !== null,
      cycleIntervalMs: this.loopIntervalMs,
      lastCycleStartedAt: this.lastCycleStartedAt,
      lastCycleCompletedAt: this.lastCycleCompletedAt,
      lastCycleError: this.lastCycleError,
      entrySignalThreshold: this.entrySignalThreshold,
      openPosition: this.riskManager.getPosition(this.symbol),
      riskMetrics: this.riskManager.getRiskMetrics(),
      journalStats: this.journal.calculateStats(),
      openOrders: this.orderExecutor.getOpenOrders(),
      dryRun: this.dryRun,
    };
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

  async restoreFromState(state: PersistedTradingState | null): Promise<void> {
    if (state) {
      if (state.symbol !== this.symbol) {
        logger.warn(
          { persistedSymbol: state.symbol, currentSymbol: this.symbol },
          'Ignoring persisted state because it targets a different symbol'
        );
      } else {
        this.journal.restoreTrades(state.journal);
        this.orderExecutor.restoreOrders(state.orders);
        this.riskManager.restoreState(state.risk);
        this.openTrades = new Map(
          state.openTrades.map((trade) => [
            trade.symbol,
            { tradeId: trade.tradeId, entryAtr: trade.entryAtr },
          ])
        );
        this.loopIntervalMs = state.runtime.cycleIntervalMs;
        this.lastCycleStartedAt = state.runtime.lastCycleStartedAt;
        this.lastCycleCompletedAt = state.runtime.lastCycleCompletedAt;
        this.lastCycleError = state.runtime.lastCycleError;
        this.state = state.runtime.state === 'paused' ? 'paused' : 'idle';

        logger.info(
          {
            filePath: this.stateStore.getFilePath(),
            paused: this.state === 'paused',
            openTradeCount: this.openTrades.size,
          },
          'Persisted trading state restored'
        );
      }
    }

    await this.reconcileWithExchange();
    await this.persistState('startup reconciliation');
  }

  private async runCycleWithLock(): Promise<void> {
    if (this.cyclePromise) {
      logger.warn({ symbol: this.symbol }, 'Skipping cycle because previous cycle is still running');
      return;
    }

    this.lastCycleStartedAt = Date.now();
    this.lastCycleError = null;
    this.state = 'running';

    const cycle = this.runCycle();
    this.cyclePromise = cycle;

    try {
      await cycle;
      this.lastCycleCompletedAt = Date.now();
    } catch (error) {
      this.lastCycleCompletedAt = Date.now();
      this.lastCycleError =
        error instanceof Error ? error.message : 'Unknown cycle error';
      logger.error({ error }, 'Managed cycle failed');
    } finally {
      this.cyclePromise = null;
      if (this.state === 'running') {
        this.state = 'idle';
      }
      await this.persistState('cycle completion');
    }
  }

  private getExitReason(
    entryPrice: number,
    currentPrice: number,
    signalAction: 'BUY' | 'SELL' | 'HOLD'
  ): string | null {
    const riskConfig = this.riskManager.getConfig();
    const openTradeState = this.openTrades.get(this.symbol);
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
      return 'Strategy exit signal';
    }

    if (openTrade && Date.now() - openTrade.entryTime >= this.maxHoldTimeMs) {
      return `Max hold time reached after ${(this.maxHoldTimeMs / 60000).toFixed(0)} minutes`;
    }

    return null;
  }

  private async closePosition(currentPrice: number, reason: string): Promise<void> {
    const position = this.riskManager.getPosition(this.symbol);
    if (!position) {
      return;
    }

    const order = await this.orderExecutor.executeOrder({
      symbol: this.symbol,
      side: 'SELL',
      type: 'MARKET',
      quantity: position.quantity,
      price: currentPrice,
      status: 'PENDING',
    });

    logger.info({ order, reason }, 'Exit order executed');
    this.riskManager.closePosition(this.symbol, order.averagePrice ?? currentPrice);

    const openTradeState = this.openTrades.get(this.symbol);
    if (openTradeState) {
      this.journal.recordExit(
        openTradeState.tradeId,
        order.averagePrice ?? currentPrice,
        order.timestamp
      );
      this.openTrades.delete(this.symbol);
    }

    await this.persistState(`position closed: ${reason}`);
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

  private async reconcileWithExchange(): Promise<void> {
    const accountInfo = await this.orderExecutor.getAccountInfo();
    const baseBalance = this.getAssetQuantity(accountInfo, this.baseAsset);
    const quoteBalance = this.getAssetQuantity(accountInfo, this.quoteAsset);
    const ticker = await this.marketDataProvider.getTicker(this.symbol);
    const tradingRules = await this.orderExecutor.getSymbolTradingRules(this.symbol);
    const baseNotional = baseBalance * ticker.price;
    const localPosition = this.riskManager.getPosition(this.symbol);
    const openTradeState = this.openTrades.get(this.symbol);
    const openTrade = openTradeState
      ? this.journal.getTrade(openTradeState.tradeId)
      : undefined;

    if (baseBalance <= 0 || baseNotional < tradingRules.minNotional) {
      if (localPosition) {
        logger.warn(
          {
            symbol: this.symbol,
            baseAsset: this.baseAsset,
            baseBalance,
            baseNotional,
            minNotional: tradingRules.minNotional,
          },
          'Clearing local position because Binance reports only non-tradable base-asset dust'
        );
        this.riskManager.removePosition(this.symbol);
        this.openTrades.delete(this.symbol);
      } else {
        this.riskManager.setAccountBalance(quoteBalance);
      }

      return;
    }

    const entryPrice = openTrade?.entryPrice ?? localPosition?.entryPrice ?? ticker.price;
    const restoredPosition = this.buildPosition(baseBalance, entryPrice, ticker.price);

    if (!localPosition) {
      this.riskManager.upsertPosition(restoredPosition);
      this.riskManager.setAccountBalance(quoteBalance);

      if (!openTradeState) {
        const syntheticTradeId = `RESTORED_${this.symbol}_${Date.now()}`;
        this.journal.recordEntry({
          id: syntheticTradeId,
          symbol: this.symbol,
          entryTime: Date.now(),
          entryPrice,
          quantity: baseBalance,
          side: 'BUY',
          strategyName: 'State Reconciliation',
          reason: 'Reconstructed from exchange balances',
          notes: 'Recovered open position on startup',
        });
        this.openTrades.set(this.symbol, {
          tradeId: syntheticTradeId,
          entryAtr: 0,
        });
      }

      logger.warn(
        { symbol: this.symbol, quantity: baseBalance, entryPrice },
        'Rebuilt missing local position from Binance balances'
      );
      return;
    }

    this.riskManager.upsertPosition({
      ...restoredPosition,
      entryPrice: openTrade?.entryPrice ?? localPosition.entryPrice,
    });

    logger.info(
      {
        symbol: this.symbol,
        exchangeQuantity: baseBalance,
        localQuantity: localPosition.quantity,
      },
      'Reconciled local position with Binance balances'
    );
  }

  private buildPosition(quantity: number, entryPrice: number, currentPrice: number): Position {
    const unrealizedPnL = (currentPrice - entryPrice) * quantity;
    const unrealizedPnLPercent =
      entryPrice > 0 ? ((currentPrice - entryPrice) / entryPrice) * 100 : 0;

    return {
      symbol: this.symbol,
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
      version: 1,
      savedAt: Date.now(),
      symbol: this.symbol,
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
      if (!this.isAuthorized(req)) {
        this.sendJson(res, 401, { error: 'Unauthorized' });
        return;
      }

      const method = req.method || 'GET';
      const url = new URL(req.url || '/', 'http://localhost');

      if (method === 'GET' && url.pathname === '/health') {
        this.sendJson(res, 200, { ok: true, status: this.system.getStatus() });
        return;
      }

      if (method === 'GET' && url.pathname === '/status') {
        this.sendJson(res, 200, this.system.getStatus());
        return;
      }

      if (method === 'POST' && url.pathname === '/pause') {
        await this.system.pauseTrading();
        this.sendJson(res, 200, this.system.getStatus());
        return;
      }

      if (method === 'POST' && url.pathname === '/resume') {
        await this.system.resumeTrading();
        this.sendJson(res, 200, this.system.getStatus());
        return;
      }

      if (method === 'POST' && url.pathname === '/close-position') {
        const body = await this.readJsonBody(req);
        const closed = await this.system.closeOpenPosition(
          typeof body.reason === 'string' && body.reason.trim().length > 0
            ? body.reason
            : 'Manual close requested'
        );
        this.sendJson(res, 200, {
          closed,
          status: this.system.getStatus(),
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
  const tradingSymbol = getTradingSymbol();
  const quoteAsset = getQuoteAsset(tradingSymbol);
  const baseAsset = getBaseAsset(tradingSymbol);
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
      `No available ${quoteAsset} balance found for trading symbol ${tradingSymbol}`
    );
  }

  logger.info(
    {
      environment,
      dryRun,
      tradingSymbol,
      quoteAsset,
      baseAsset,
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
    tradingSymbol,
    {
      quoteAsset,
      baseAsset,
      stateStore,
      liveMaxOrderNotional,
    }
  );

  await system.restoreFromState(persistedState);

  const controlServer = new ControlServer(system, controlServerConfig);
  await controlServer.start();

  // Run continuously with 60-second interval (adjust as needed)
  await system.runContinuous(60000);
}

main().catch((error) => {
  logger.error({ error }, 'Fatal error in main');
  process.exit(1);
});

export { TradingSystem };
