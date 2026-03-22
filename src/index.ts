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

  async runExample(): Promise<void> {
    try {
      // Example: Fetch market data
      logger.info('Fetching market data...');
      const ticker: Ticker = await this.marketDataProvider.getTicker(
        'BTCUSDT'
      );
      logger.info(
        { ticker },
        'Market data fetched successfully'
      );

      // Example: Get candle data for strategy analysis
      const candles: CandleData[] = await this.marketDataProvider.getCandles(
        'BTCUSDT',
        '1h',
        50
      );
      logger.info(
        { candleCount: candles.length },
        'Candle data retrieved'
      );

      // Example: Create and run strategy
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

      // Example: Risk management
      const riskMetrics = this.riskManager.getRiskMetrics();
      logger.info(
        { riskMetrics },
        'Risk metrics calculated'
      );

      // Example: Order execution (simulated)
      if (signal.action === 'BUY' && signal.confidence > 0.5) {
        const order = await this.orderExecutor.executeOrder({
          symbol: 'BTCUSDT',
          side: 'BUY',
          type: 'MARKET',
          quantity: 0.01,
          timestamp: Date.now(),
          status: 'PENDING',
        });

        logger.info({ order }, 'Order executed');

        // Record in journal
        this.journal.recordEntry({
          id: order.id!,
          symbol: 'BTCUSDT',
          entryTime: order.timestamp,
          entryPrice: ticker.price,
          quantity: order.quantity,
          side: 'BUY',
          strategyName: strategy.getName(),
          notes: `Confidence: ${signal.confidence.toFixed(2)}`,
        });
      }

      // Display journal stats
      const stats = this.journal.calculateStats();
      logger.info({ stats }, 'Trading journal stats');

      logger.info('Example trading cycle completed successfully');
    } catch (error) {
      logger.error({ error }, 'Error in trading system');
      throw error;
    }
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
  };

  const system = new TradingSystem(
    new MarketDataProvider(),
    executionConfig,
    riskConfig,
    10000 // Initial balance: $10,000
  );

  await system.runExample();
}

main().catch((error) => {
  logger.error({ error }, 'Fatal error in main');
  process.exit(1);
});

export { TradingSystem };
