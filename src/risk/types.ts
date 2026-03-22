export interface RiskConfig {
  maxPositionSize: number;
  maxDrawdownPercent: number;
  stopLossPercent: number;
  takeProfitPercent: number;
  dailyLossLimit: number;
  maxRiskPerTradePercent: number; // 1% default
  maxDailyLossPercent: number; // 2% default
}

export interface PositionSizing {
  riskPerTrade: number;
  maxDailyRisk: number;
  positionSize: number;
}

export interface Position {
  symbol: string;
  quantity: number;
  entryPrice: number;
  currentPrice: number;
  unrealizedPnL: number;
  unrealizedPnLPercent: number;
}

export interface RiskMetrics {
  totalPositions: number;
  totalExposure: number;
  realizedPnL: number;
  unrealizedPnL: number;
  drawdown: number;
  drawdownPercent: number;
}
