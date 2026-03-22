import logger from './logger';
import { TradeJournal } from './journal';

async function main(): Promise<void> {
  const journal = new TradeJournal();

  logger.info('Trade journal demo started');

  // Simulate trade entry
  journal.recordEntry({
    id: 'T1',
    symbol: 'BTCUSDT',
    entryTime: Date.now(),
    entryPrice: 69000,
    quantity: 0.001,
    side: 'BUY',
    strategyName: 'EMA Strategy',
    reason: 'Price above 200 EMA and near 20 EMA',
  });

  // Simulate exit after some time
  setTimeout(() => {
    const currentTime = Date.now();
    const trade = journal.recordExit('T1', 69200, currentTime);

    if (trade) {
      trade.reason = 'Target profit reached';
    }

    logger.info({ trade }, 'Trade closed');

    const stats = journal.calculateStats();
    logger.info({ stats }, 'Journal stats');

    const csv = journal.exportToCSV();
    logger.info({ csv }, 'CSV Export');
  }, 1000);
}

main();
