import 'dotenv/config';
import logger from './logger';
import { PaperTrader } from './execution';

async function main(): Promise<void> {
  const trader = new PaperTrader({ startingBalance: 100000, feePercent: 0.001 });

  try {
    logger.info('Paper trading simulation started');

    // Simulate buy
    const buy = trader.simulateOrder('BTCUSDT', 'BUY', 70000, 0.001);
    logger.info({ buy }, 'Buy simulated');

    // Simulate sell
    const sell = trader.simulateOrder('BTCUSDT', 'SELL', 70500, 0.001);
    logger.info({ sell }, 'Sell simulated');

    const summary = trader.getSummary();
    logger.info({ summary }, 'Paper trader summary');
  } catch (error) {
    logger.error({ error }, 'Paper trading simulation failed');
  }
}

main();
