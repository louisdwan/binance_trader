import logger from '../logger';
import type { RiskConfig, Position, RiskMetrics } from './types';

export class RiskManager {
  private config: RiskConfig;
  private positions: Map<string, Position> = new Map();
  private accountBalance: number;
  private realizedPnL: number = 0;
  private dailyRealizedPnL: number = 0;
  private peakEquity: number;
  private currentDay: string;

  constructor(config: RiskConfig, initialBalance: number) {
    this.config = {
      maxPositionSize: config.maxPositionSize,
      maxDrawdownPercent: config.maxDrawdownPercent,
      stopLossPercent: config.stopLossPercent,
      takeProfitPercent: config.takeProfitPercent,
      dailyLossLimit: config.dailyLossLimit,
      maxRiskPerTradePercent: config.maxRiskPerTradePercent ?? 1,
      maxDailyLossPercent: config.maxDailyLossPercent ?? 2,
    };

    this.accountBalance = initialBalance;
    this.peakEquity = initialBalance;
    this.currentDay = this.getDayKey(Date.now());

    logger.info(
      { config: this.config, initialBalance },
      'RiskManager initialized'
    );
  }

  openPosition(
    symbol: string,
    quantity: number,
    entryPrice: number
  ): Position {
    this.rollDayIfNeeded();

    if (this.positions.has(symbol)) {
      throw new Error(`Position for ${symbol} already exists`);
    }

    if (!this.canOpenPosition(quantity, entryPrice)) {
      throw new Error(`Position for ${symbol} exceeds risk limits`);
    }

    const position: Position = {
      symbol,
      quantity,
      entryPrice,
      currentPrice: entryPrice,
      unrealizedPnL: 0,
      unrealizedPnLPercent: 0,
    };

    this.positions.set(symbol, position);
    this.updatePeakEquity();

    logger.info(
      { symbol, quantity, entryPrice },
      'Position opened'
    );

    return position;
  }

  closePosition(symbol: string, exitPrice: number): Position | null {
    this.rollDayIfNeeded();
    const position = this.positions.get(symbol);

    if (!position) {
      logger.warn({ symbol }, 'Position not found');
      return null;
    }

    const pnl = (exitPrice - position.entryPrice) * position.quantity;
    this.realizedPnL += pnl;
    this.dailyRealizedPnL += pnl;
    this.accountBalance += pnl;

    this.positions.delete(symbol);
    this.updatePeakEquity();

    logger.info(
      { symbol, exitPrice, pnl },
      'Position closed'
    );

    return position;
  }

  updatePositionPrice(symbol: string, currentPrice: number): void {
    this.rollDayIfNeeded();
    const position = this.positions.get(symbol);

    if (!position) {
      return;
    }

    position.currentPrice = currentPrice;
    position.unrealizedPnL =
      (currentPrice - position.entryPrice) * position.quantity;
    position.unrealizedPnLPercent =
      ((currentPrice - position.entryPrice) / position.entryPrice) * 100;
    this.updatePeakEquity();
  }

  getPosition(symbol: string): Position | undefined {
    return this.positions.get(symbol);
  }

  getAllPositions(): Position[] {
    return Array.from(this.positions.values());
  }

  canOpenPosition(quantity: number, price: number): boolean {
    const notionalValue = quantity * price;
    const currentExposure = Array.from(this.positions.values()).reduce(
      (sum, position) => sum + position.quantity * position.currentPrice,
      0
    );
    const exposureLimit = this.getEquity() * (this.config.maxPositionSize / 100);

    return currentExposure + notionalValue <= exposureLimit;
  }

  getRiskMetrics(): RiskMetrics {
    const positions = Array.from(this.positions.values());
    const totalExposure = positions.reduce(
      (sum, pos) => sum + pos.quantity * pos.currentPrice,
      0
    );
    const unrealizedPnL = positions.reduce(
      (sum, pos) => sum + pos.unrealizedPnL,
      0
    );

    const equity = this.accountBalance + unrealizedPnL;
    this.peakEquity = Math.max(this.peakEquity, equity);
    const drawdown = Math.max(0, this.peakEquity - equity);
    const drawdownPercent =
      this.peakEquity > 0 ? (drawdown / this.peakEquity) * 100 : 0;

    return {
      totalPositions: positions.length,
      totalExposure,
      realizedPnL: this.realizedPnL,
      unrealizedPnL,
      drawdown,
      drawdownPercent,
    };
  }

  getAccountBalance(): number {
    return this.accountBalance;
  }

  calculatePositionSize(balance: number, stopDistance: number): number {
    if (balance <= 0 || stopDistance <= 0) {
      throw new Error('Balance and stopDistance must be positive numbers');
    }

    const riskPerTrade = (this.config.maxRiskPerTradePercent / 100) * balance;
    const rawSize = riskPerTrade / stopDistance;
    const positionSize = Math.max(0, rawSize);

    return positionSize;
  }

  validateRisk(): boolean {
    this.rollDayIfNeeded();
    const metrics = this.getRiskMetrics();
    const dailyLoss = Math.max(0, -this.dailyRealizedPnL);
    const dailyLossPercent =
      this.peakEquity > 0 ? (dailyLoss / this.peakEquity) * 100 : 0;

    if (metrics.drawdownPercent > this.config.maxDrawdownPercent) {
      logger.warn(
        { drawdownPercent: metrics.drawdownPercent },
        'Drawdown limit exceeded'
      );
      return false;
    }

    if (dailyLoss > this.config.dailyLossLimit) {
      logger.warn(
        { dailyLoss, dailyLossLimit: this.config.dailyLossLimit },
        'Daily loss limit exceeded'
      );
      return false;
    }

    if (dailyLossPercent > this.config.maxDailyLossPercent) {
      logger.warn(
        { dailyLossPercent, maxDailyLossPercent: this.config.maxDailyLossPercent },
        'Daily percentage loss limit exceeded'
      );
      return false;
    }

    return true;
  }

  private getEquity(): number {
    const unrealizedPnL = Array.from(this.positions.values()).reduce(
      (sum, position) => sum + position.unrealizedPnL,
      0
    );

    return this.accountBalance + unrealizedPnL;
  }

  private updatePeakEquity(): void {
    this.peakEquity = Math.max(this.peakEquity, this.getEquity());
  }

  private getDayKey(timestamp: number): string {
    return new Date(timestamp).toISOString().slice(0, 10);
  }

  private rollDayIfNeeded(): void {
    const currentDay = this.getDayKey(Date.now());
    if (currentDay !== this.currentDay) {
      this.currentDay = currentDay;
      this.dailyRealizedPnL = 0;
    }
  }
}
