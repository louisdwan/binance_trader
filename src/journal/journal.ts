import logger from '../logger';
import type { TradeEntry, JournalStats } from './types';

export class TradeJournal {
  private trades: TradeEntry[] = [];
  private tradeMap: Map<string, TradeEntry> = new Map();

  recordEntry(trade: TradeEntry): void {
    this.trades.push(trade);
    this.tradeMap.set(trade.id, trade);

    logger.info(
      {
        tradeId: trade.id,
        symbol: trade.symbol,
        side: trade.side,
        entryPrice: trade.entryPrice,
        reason: trade.reason,
        timestamp: trade.entryTime,
      },
      'Trade entry recorded'
    );
  }

  recordExit(
    tradeId: string,
    exitPrice: number,
    exitTime: number
  ): TradeEntry | null {
    const trade = this.tradeMap.get(tradeId);

    if (!trade) {
      logger.warn({ tradeId }, 'Trade not found');
      return null;
    }

    trade.exitPrice = exitPrice;
    trade.exitTime = exitTime;

    // Calculate PnL
    if (trade.side === 'BUY') {
      trade.pnl = (exitPrice - trade.entryPrice) * trade.quantity;
    } else {
      trade.pnl = (trade.entryPrice - exitPrice) * trade.quantity;
    }

    trade.pnlPercent = (trade.pnl / (trade.entryPrice * trade.quantity)) * 100;

    logger.info(
      { tradeId, pnl: trade.pnl, pnlPercent: trade.pnlPercent },
      'Trade exit recorded'
    );

    return trade;
  }

  getTrade(tradeId: string): TradeEntry | undefined {
    return this.tradeMap.get(tradeId);
  }

  getAllTrades(): TradeEntry[] {
    return [...this.trades];
  }

  getTradesBySymbol(symbol: string): TradeEntry[] {
    return this.trades.filter((trade) => trade.symbol === symbol);
  }

  getTradesByStrategy(strategyName: string): TradeEntry[] {
    return this.trades.filter((trade) => trade.strategyName === strategyName);
  }

  getClosedTrades(): TradeEntry[] {
    return this.trades.filter((trade) => trade.exitPrice);
  }

  calculateStats(): JournalStats {
    const closedTrades = this.getClosedTrades();

    if (closedTrades.length === 0) {
      return {
        totalTrades: 0,
        winningTrades: 0,
        losingTrades: 0,
        winRate: 0,
        totalPnL: 0,
        averageWin: 0,
        averageLoss: 0,
        profitFactor: 0,
      };
    }

    const winningTrades = closedTrades.filter((trade) => trade.pnl! > 0);
    const losingTrades = closedTrades.filter((trade) => trade.pnl! < 0);
    const totalPnL = closedTrades.reduce((sum, trade) => sum + trade.pnl!, 0);

    const grossProfit = winningTrades.reduce(
      (sum, trade) => sum + trade.pnl!,
      0
    );
    const grossLoss = Math.abs(
      losingTrades.reduce((sum, trade) => sum + trade.pnl!, 0)
    );

    return {
      totalTrades: closedTrades.length,
      winningTrades: winningTrades.length,
      losingTrades: losingTrades.length,
      winRate: (winningTrades.length / closedTrades.length) * 100,
      totalPnL,
      averageWin:
        winningTrades.length > 0
          ? grossProfit / winningTrades.length
          : 0,
      averageLoss:
        losingTrades.length > 0
          ? -grossLoss / losingTrades.length
          : 0,
      profitFactor: grossLoss > 0 ? grossProfit / grossLoss : 0,
    };
  }

  exportToCSV(): string {
    const headers = [
      'ID',
      'Symbol',
      'Entry Time',
      'Exit Time',
      'Entry Price',
      'Exit Price',
      'Quantity',
      'Side',
      'PnL',
      'PnL %',
      'Strategy',
      'Reason',
      'Notes',
    ];

    const rows = this.trades.map((trade) => [
      trade.id,
      trade.symbol,
      new Date(trade.entryTime).toISOString(),
      trade.exitTime ? new Date(trade.exitTime).toISOString() : '',
      trade.entryPrice,
      trade.exitPrice || '',
      trade.quantity,
      trade.side,
      trade.pnl || '',
      trade.pnlPercent?.toFixed(2) || '',
      trade.strategyName,
      trade.reason || '',
      trade.notes || '',
    ]);

    const csv = [
      headers.join(','),
      ...rows.map((row) => row.join(',')),
    ].join('\n');

    return csv;
  }
}
