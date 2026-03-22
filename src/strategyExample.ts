import 'dotenv/config';
import logger from './logger';
import { getPriceDatabase, PriceDatabase } from './marketData';
import { EMAStrategy } from './strategy';

/**
 * Example: Test EMA strategy with historical price data from database
 * Loads the 200 most recent prices and generates trading signals
 */
async function main(): Promise<void> {
  let db: PriceDatabase;
  try {
    db = await getPriceDatabase('./prices.db');
  } catch (error) {
    logger.error({ error }, 'Failed to initialize database');
    process.exit(1);
  }

  try {
    logger.info('EMA Strategy Analyzer');
    logger.info('='.repeat(50));

    // Get stored symbols
    const symbols = db.getAllSymbols();

    if (symbols.length === 0) {
      logger.warn('No price data found in database. Run npm run stream first to collect data.');
      db.close();
      process.exit(0);
    }

    const strategy = new EMAStrategy();

    // Analyze each symbol
    for (const symbol of symbols) {
      logger.info(`\nAnalyzing ${symbol}...`);

      // Get the 200 most recent prices
      const prices = db.getPricesBySymbol(symbol, 200);

      if (prices.length < 200) {
        logger.warn(
          {
            symbol,
            priceCount: prices.length,
          },
          'Insufficient data for analysis (need at least 200 prices)'
        );
        continue;
      }

      // Convert price records to candle format
      const candles = prices
        .reverse() // Put oldest first for EMA calculation
        .map((price) => ({
          timestamp: price.timestamp,
          open: price.price,
          high: price.price,
          low: price.price,
          close: price.price,
          volume: 0,
        }));

      // Generate signal
      const signal = strategy.analyze(candles);

      // Display results
      logger.info(
        {
          action: signal.action,
          confidence: (signal.confidence * 100).toFixed(1) + '%',
          currentPrice: `$${signal.currentPrice.toFixed(2)}`,
          ema20: `$${signal.ema20.toFixed(2)}`,
          ema200: `$${signal.ema200.toFixed(2)}`,
        },
        'Strategy Signal'
      );

      logger.info(
        {
          priceAboveEMA200: signal.priceAboveEMA200,
          priceNearEMA20: signal.priceNearEMA20,
        },
        'Conditions'
      );

      logger.info(`Reason: ${signal.reason}`);

      // Display price statistics
      const stats = db.getStatistics(symbol);
      if (stats) {
        logger.info(
          {
            totalPrices: stats.count,
            minPrice: `$${stats.minPrice.toFixed(2)}`,
            maxPrice: `$${stats.maxPrice.toFixed(2)}`,
            avgPrice: `$${stats.avgPrice.toFixed(2)}`,
          },
          'Price Statistics'
        );
      }
    }

    logger.info('\n' + '='.repeat(50));
    logger.info('Analysis complete');

    db.close();
  } catch (error) {
    logger.error({ error }, 'Error during analysis');
    db.close();
    process.exit(1);
  }
}

main();
