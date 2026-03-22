export interface TradeEntry {
  id: string;
  symbol: string;
  entryTime: number;
  exitTime?: number;
  entryPrice: number;
  exitPrice?: number;
  quantity: number;
  side: 'BUY' | 'SELL';
  pnl?: number;
  pnlPercent?: number;
  strategyName: string;
  reason?: string;
  notes?: string;
}

export interface JournalStats {
  totalTrades: number;
  winningTrades: number;
  losingTrades: number;
  winRate: number;
  totalPnL: number;
  averageWin: number;
  averageLoss: number;
  profitFactor: number;
}
