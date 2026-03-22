import logger from '../logger';
import type { TradeEntry, JournalStats } from './types';

export class TradeJournal {
  private trades: TradeEntry[] = [];
  private tradeMap: Map<string, TradeEntry> = new Map();

  recordEntry(trade: TradeEntry): void {
    trade.entryPrice = this.ensureFinite(
      trade.entryPrice,
      `entry price for trade ${trade.id}`
    );
    trade.quantity = this.ensureFinite(
      trade.quantity,
      `quantity for trade ${trade.id}`
    );
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

    const safeExitPrice = this.ensureFinite(exitPrice, `exit price for trade ${tradeId}`);
    trade.exitPrice = safeExitPrice;
    trade.exitTime = exitTime;

    // Calculate PnL
    if (trade.side === 'BUY') {
      trade.pnl = this.ensureFinite(
        (safeExitPrice - trade.entryPrice) * trade.quantity,
        `pnl for trade ${tradeId}`
      );
    } else {
      trade.pnl = this.ensureFinite(
        (trade.entryPrice - safeExitPrice) * trade.quantity,
        `pnl for trade ${tradeId}`
      );
    }

    const notional = trade.entryPrice * trade.quantity;
    trade.pnlPercent = notional !== 0
      ? this.ensureFinite(
          (trade.pnl / notional) * 100,
          `pnl percent for trade ${tradeId}`
        )
      : 0;

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
    return this.trades.filter((trade) => trade.exitPrice !== undefined);
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
    const totalPnL = this.ensureFinite(
      closedTrades.reduce((sum, trade) => sum + this.ensureFinite(trade.pnl ?? 0, `trade pnl ${trade.id}`), 0),
      'journal total pnl'
    );

    const grossProfit = this.ensureFinite(
      winningTrades.reduce(
        (sum, trade) => sum + this.ensureFinite(trade.pnl ?? 0, `winning trade pnl ${trade.id}`),
        0
      ),
      'journal gross profit'
    );
    const grossLoss = this.ensureFinite(
      Math.abs(
        losingTrades.reduce(
          (sum, trade) => sum + this.ensureFinite(trade.pnl ?? 0, `losing trade pnl ${trade.id}`),
          0
        )
      ),
      'journal gross loss'
    );

    return {
      totalTrades: closedTrades.length,
      winningTrades: winningTrades.length,
      losingTrades: losingTrades.length,
      winRate: this.ensureFinite(
        (winningTrades.length / closedTrades.length) * 100,
        'journal win rate'
      ),
      totalPnL,
      averageWin:
        winningTrades.length > 0
          ? this.ensureFinite(grossProfit / winningTrades.length, 'journal average win')
          : 0,
      averageLoss:
        losingTrades.length > 0
          ? this.ensureFinite(-grossLoss / losingTrades.length, 'journal average loss')
          : 0,
      profitFactor:
        grossLoss > 0
          ? this.ensureFinite(grossProfit / grossLoss, 'journal profit factor')
          : 0,
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
      trade.pnl ?? '',
      trade.pnlPercent !== undefined ? trade.pnlPercent.toFixed(2) : '',
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

  private ensureFinite(value: number, label: string): number {
    if (Number.isFinite(value)) {
      return value;
    }

    logger.warn({ label, value }, 'Non-finite journal value encountered; clamping to 0');
    return 0;
  }
}
