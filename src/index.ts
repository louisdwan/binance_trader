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
import { OrderExecutor, type ExecutionConfig } from './execution';
import { RiskManager, type RiskConfig } from './risk';
import { TradeJournal } from './journal';

class TradingSystem {
  private marketDataProvider: MarketDataProvider;
  private orderExecutor: OrderExecutor;
  private riskManager: RiskManager;
  private journal: TradeJournal;

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
        'BTCUSDT'
      );
      logger.info(
        { ticker },
        'Market data fetched successfully'
      );

      // Get candle data for strategy analysis
      const candles: CandleData[] = await this.marketDataProvider.getCandles(
        'BTCUSDT',
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
        symbol: 'BTCUSDT',
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

      // Risk management
      const riskMetrics = this.riskManager.getRiskMetrics();
      logger.info(
        { riskMetrics },
        'Risk metrics calculated'
      );

      // Order execution (simulated)
      if (signal.action === 'BUY' && signal.confidence > 0.5) {
        const existingPosition = this.riskManager.getPosition('BTCUSDT');
        if (existingPosition) {
          this.riskManager.updatePositionPrice('BTCUSDT', ticker.price);
          logger.info(
            { symbol: 'BTCUSDT' },
            'Skipping BUY because a position is already open'
          );
          return;
        }

        if (!this.riskManager.validateRisk()) {
          logger.warn('Skipping BUY because portfolio risk limits are exceeded');
          return;
        }

        const quantity = 0.01;
        if (!this.riskManager.canOpenPosition(quantity, ticker.price)) {
          logger.warn(
            { symbol: 'BTCUSDT', quantity, price: ticker.price },
            'Skipping BUY because position would exceed exposure limits'
          );
          return;
        }

        const order = await this.orderExecutor.executeOrder({
          symbol: 'BTCUSDT',
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

        // Record in journal
        this.journal.recordEntry({
          id: order.id!,
          symbol: 'BTCUSDT',
          entryTime: order.timestamp,
          entryPrice: order.averagePrice ?? ticker.price,
          quantity: order.quantity,
          side: 'BUY',
          strategyName: strategy.getName(),
          reason: signal.reasoning,
          notes: `Confidence: ${signal.confidence.toFixed(2)}`,
        });
      } else {
        const existingPosition = this.riskManager.getPosition('BTCUSDT');
        if (existingPosition) {
          this.riskManager.updatePositionPrice('BTCUSDT', ticker.price);
        }
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

  const system = new TradingSystem(
    new MarketDataProvider(),
    executionConfig,
    riskConfig,
    10000 // Initial balance: $10,000
  );

  // Run continuously with 60-second interval (adjust as needed)
  await system.runContinuous(60000);
}

main().catch((error) => {
  logger.error({ error }, 'Fatal error in main');
  process.exit(1);
});

export { TradingSystem };
