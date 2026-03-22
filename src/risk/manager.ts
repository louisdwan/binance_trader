import logger from '../logger';
import type { RiskConfig, Position, RiskMetrics } from './types';

export class RiskManager {
  private config: RiskConfig;
  private positions: Map<string, Position> = new Map();
  private accountBalance: number;
  private realizedPnL: number = 0;

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
    const position: Position = {
      symbol,
      quantity,
      entryPrice,
      currentPrice: entryPrice,
      unrealizedPnL: 0,
      unrealizedPnLPercent: 0,
    };

    this.positions.set(symbol, position);

    logger.info(
      { symbol, quantity, entryPrice },
      'Position opened'
    );

    return position;
  }

  closePosition(symbol: string, exitPrice: number): Position | null {
    const position = this.positions.get(symbol);

    if (!position) {
      logger.warn({ symbol }, 'Position not found');
      return null;
    }

    const pnl = (exitPrice - position.entryPrice) * position.quantity;
    this.realizedPnL += pnl;
    this.accountBalance += pnl;

    this.positions.delete(symbol);

    logger.info(
      { symbol, exitPrice, pnl },
      'Position closed'
    );

    return position;
  }

  updatePositionPrice(symbol: string, currentPrice: number): void {
    const position = this.positions.get(symbol);

    if (!position) {
      return;
    }

    position.currentPrice = currentPrice;
    position.unrealizedPnL =
      (currentPrice - position.entryPrice) * position.quantity;
    position.unrealizedPnLPercent =
      ((currentPrice - position.entryPrice) / position.entryPrice) * 100;
  }

  getPosition(symbol: string): Position | undefined {
    return this.positions.get(symbol);
  }

  getAllPositions(): Position[] {
    return Array.from(this.positions.values());
  }

  canOpenPosition(quantity: number, price: number): boolean {
    const notionalValue = quantity * price;
    const exposureLimit =
      this.accountBalance * (this.config.maxPositionSize / 100);

    return notionalValue <= exposureLimit;
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

    const maxBalance =
      this.accountBalance +
      Math.abs(Math.max(0, -unrealizedPnL, -this.realizedPnL));
    const drawdown = Math.max(
      0,
      -unrealizedPnL - this.realizedPnL
    );
    const drawdownPercent = (drawdown / maxBalance) * 100;

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
    const maxDailyRisk = (this.config.maxDailyLossPercent / 100) * balance;

    // Whether single trade risk is capped to max risk percentages.
    const rawSize = riskPerTrade / stopDistance;

    // add buffer for scenario enforcement (like before daily threshold)
    const positionSize = Math.max(0, rawSize);

    return positionSize;
  }

  validateRisk(): boolean {
    const metrics = this.getRiskMetrics();

    if (metrics.drawdownPercent > this.config.maxDrawdownPercent) {
      logger.warn(
        { drawdownPercent: metrics.drawdownPercent },
        'Drawdown limit exceeded'
      );
      return false;
    }

    return true;
  }
}
