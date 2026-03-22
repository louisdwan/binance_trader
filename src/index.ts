import 'dotenv/config';
import logger from './logger';
import {
  MarketDataProvider,
  type Ticker,
  type CandleData,
} from './marketData';
import {
  SimpleMovingAverageStrategy,
  type StrategyConfig,
} from './strategy';
import {
  OrderExecutor,
  type ExecutionConfig,
  type AccountBalance,
  type AccountInfo,
} from './execution';
import { RiskManager, type RiskConfig } from './risk';
import { TradeJournal } from './journal';

class TradingSystem {
  private marketDataProvider: MarketDataProvider;
  private orderExecutor: OrderExecutor;
  private riskManager: RiskManager;
  private journal: TradeJournal;
  private openTradeIds: Map<string, string> = new Map();
  private readonly symbol: string = 'BTCUSDT';
  private readonly entrySignalThreshold: number = 0.05;
  private readonly quantityPrecision: number = 6;

  constructor(
    marketDataProvider: MarketDataProvider,
    executionConfig: ExecutionConfig,
    riskConfig: RiskConfig,
    initialBalance: number
  ) {
    this.marketDataProvider = marketDataProvider;
    this.orderExecutor = new OrderExecutor(executionConfig);
    this.riskManager = new RiskManager(riskConfig, initialBalance);
    this.journal = new TradeJournal();

    logger.info('Trading system initialized');
  }

  async runCycle(): Promise<void> {
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
        50
      );
      logger.info(
        { candleCount: candles.length },
        'Candle data retrieved'
      );

      // Create and run strategy
      const strategyConfig: StrategyConfig = {
        name: 'SMA Strategy',
        symbol: this.symbol,
        enabled: true,
        parameters: {
          fastPeriod: 5,
          slowPeriod: 20,
        },
      };

      const strategy = new SimpleMovingAverageStrategy(strategyConfig);
      strategy.updateCandles(candles);
      const signal = strategy.analyze();
      logger.info({ signal }, 'Strategy signal generated');

      this.logRiskMetrics('Risk metrics before trade evaluation');

      const existingPosition = this.riskManager.getPosition(this.symbol);
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
          logger.warn('Skipping BUY because portfolio risk limits are exceeded');
        } else if (!existingPosition) {
          const quantity = this.calculateOrderQuantity(ticker.price);
          if (!this.riskManager.canOpenPosition(quantity, ticker.price)) {
            logger.warn(
              { symbol: this.symbol, quantity, price: ticker.price },
              'Skipping BUY because position would exceed exposure limits'
            );
          } else {
            const order = await this.orderExecutor.executeOrder({
              symbol: this.symbol,
              side: 'BUY',
              type: 'MARKET',
              quantity,
              price: ticker.price,
              status: 'PENDING',
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
            this.openTradeIds.set(this.symbol, order.id!);
            this.logRiskMetrics('Risk metrics after opening position');
          }
        } else {
          logger.info(
            { symbol: this.symbol },
            'Skipping BUY because a position is already open'
          );
        }
      } else {
        logger.info(
          { action: signal.action, confidence: signal.confidence, threshold: this.entrySignalThreshold },
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
    logger.info(
      { intervalMs },
      'Starting continuous trading system (interval in ms)'
    );

    // Run once immediately
    await this.runCycle();

    // Then run on interval
    setInterval(async () => {
      try {
        await this.runCycle();
      } catch (error) {
        logger.error({ error }, 'Error in continuous trading cycle');
        // Continue running despite error
      }
    }, intervalMs);

    // Never exit
    await new Promise(() => {});
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

  private getExitReason(
    entryPrice: number,
    currentPrice: number,
    signalAction: 'BUY' | 'SELL' | 'HOLD'
  ): string | null {
    const riskConfig = this.riskManager.getConfig();
    const priceChangePercent = ((currentPrice - entryPrice) / entryPrice) * 100;

    if (priceChangePercent <= -riskConfig.stopLossPercent) {
      return `Stop loss triggered at ${priceChangePercent.toFixed(2)}%`;
    }

    if (priceChangePercent >= riskConfig.takeProfitPercent) {
      return `Take profit triggered at ${priceChangePercent.toFixed(2)}%`;
    }

    if (signalAction === 'SELL') {
      return 'Strategy exit signal';
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

    const tradeId = this.openTradeIds.get(this.symbol);
    if (tradeId) {
      this.journal.recordExit(
        tradeId,
        order.averagePrice ?? currentPrice,
        order.timestamp
      );
      this.openTradeIds.delete(this.symbol);
    }
  }

  private logRiskMetrics(message: string): void {
    const riskMetrics = this.riskManager.getRiskMetrics();
    logger.info({ riskMetrics }, message);
  }

  private calculateOrderQuantity(price: number): number {
    const riskConfig = this.riskManager.getConfig();
    const maxNotional =
      this.riskManager.getAccountBalance() * (riskConfig.maxPositionSize / 100);
    const rawQuantity = maxNotional / price;
    const factor = 10 ** this.quantityPrecision;
    const quantity = Math.floor(rawQuantity * factor) / factor;

    logger.info(
      { price, maxNotional, rawQuantity, quantity },
      'Calculated dynamic order quantity'
    );

    return quantity;
  }
}

// Main execution
async function main(): Promise<void> {
  const executionConfig: ExecutionConfig = {
    apiKey: process.env.BINANCE_API_KEY || '',
    apiSecret: process.env.BINANCE_API_SECRET || '',
    testnet: true,
  };

  const riskConfig: RiskConfig = {
    maxPositionSize: 5,
    maxDrawdownPercent: 10,
    stopLossPercent: 2,
    takeProfitPercent: 5,
    dailyLossLimit: 500,
    maxRiskPerTradePercent: 1,
    maxDailyLossPercent: 2,
  };

  const accountInfo: AccountInfo = await OrderExecutor.fetchAccountInfo(
    executionConfig
  );
  const trackedAssets = ['USDT', 'BTC', 'BNB', 'ETH'];
  const balances = accountInfo.balances.filter(
    (balance: AccountBalance) =>
      trackedAssets.includes(balance.asset) &&
      (balance.free > 0 || balance.locked > 0)
  );
  const usdtBalance =
    accountInfo.balances.find((balance) => balance.asset === 'USDT')?.free ?? 0;

  logger.info(
    {
      canTrade: accountInfo.canTrade,
      canWithdraw: accountInfo.canWithdraw,
      canDeposit: accountInfo.canDeposit,
      balances,
    },
    'Fetched Binance account balances'
  );

  const system = new TradingSystem(
    new MarketDataProvider(),
    executionConfig,
    riskConfig,
    usdtBalance
  );

  // Run continuously with 60-second interval (adjust as needed)
  await system.runContinuous(60000);
}

main().catch((error) => {
  logger.error({ error }, 'Fatal error in main');
  process.exit(1);
});

export { TradingSystem };
