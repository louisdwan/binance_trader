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

    this.accountBalance = this.ensureFinite(initialBalance, 'initialBalance');
    this.peakEquity = this.accountBalance;
    this.currentDay = this.getDayKey(Date.now());

    logger.info(
      { config: this.config, initialBalance: this.accountBalance },
      'RiskManager initialized'
    );
  }

  openPosition(
    symbol: string,
    quantity: number,
    entryPrice: number
  ): Position {
    this.rollDayIfNeeded();

    const safeQuantity = this.ensureFinite(quantity, `position quantity for ${symbol}`);
    const safeEntryPrice = this.ensureFinite(entryPrice, `entry price for ${symbol}`);

    if (this.positions.has(symbol)) {
      throw new Error(`Position for ${symbol} already exists`);
    }

    if (!this.canOpenPosition(safeQuantity, safeEntryPrice)) {
      throw new Error(`Position for ${symbol} exceeds risk limits`);
    }

    const position: Position = {
      symbol,
      quantity: safeQuantity,
      entryPrice: safeEntryPrice,
      currentPrice: safeEntryPrice,
      unrealizedPnL: 0,
      unrealizedPnLPercent: 0,
    };

    this.positions.set(symbol, position);
    this.updatePeakEquity();

    logger.info(
      { symbol, quantity: safeQuantity, entryPrice: safeEntryPrice },
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

    const safeExitPrice = this.ensureFinite(exitPrice, `exit price for ${symbol}`);
    const pnl = this.ensureFinite(
      (safeExitPrice - position.entryPrice) * position.quantity,
      `realized pnl for ${symbol}`
    );
    this.realizedPnL += pnl;
    this.dailyRealizedPnL += pnl;
    this.accountBalance += pnl;

    this.positions.delete(symbol);
    this.updatePeakEquity();

    logger.info(
      { symbol, exitPrice: safeExitPrice, pnl },
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

    const safeCurrentPrice = this.ensureFinite(
      currentPrice,
      `current price for ${symbol}`
    );

    position.currentPrice = safeCurrentPrice;
    position.unrealizedPnL = this.ensureFinite(
      (safeCurrentPrice - position.entryPrice) * position.quantity,
      `unrealized pnl for ${symbol}`
    );
    position.unrealizedPnLPercent = position.entryPrice !== 0
      ? this.ensureFinite(
          ((safeCurrentPrice - position.entryPrice) / position.entryPrice) * 100,
          `unrealized pnl percent for ${symbol}`
        )
      : 0;
    this.updatePeakEquity();
  }

  getPosition(symbol: string): Position | undefined {
    return this.positions.get(symbol);
  }

  getAllPositions(): Position[] {
    return Array.from(this.positions.values());
  }

  canOpenPosition(quantity: number, price: number): boolean {
    const safeQuantity = this.ensureFinite(quantity, 'position size check quantity');
    const safePrice = this.ensureFinite(price, 'position size check price');
    const notionalValue = safeQuantity * safePrice;
    const currentExposure = Array.from(this.positions.values()).reduce(
      (sum, position) => sum + position.quantity * position.currentPrice,
      0
    );
    const exposureLimit = this.getEquity() * (this.config.maxPositionSize / 100);

    return currentExposure + notionalValue <= exposureLimit;
  }

  getRiskMetrics(): RiskMetrics {
    const positions = Array.from(this.positions.values());
    const totalExposure = this.ensureFinite(
      positions.reduce((sum, pos) => sum + pos.quantity * pos.currentPrice, 0),
      'total exposure'
    );
    const unrealizedPnL = this.ensureFinite(
      positions.reduce((sum, pos) => sum + pos.unrealizedPnL, 0),
      'unrealized pnl total'
    );

    const equity = this.ensureFinite(
      this.accountBalance + unrealizedPnL,
      'portfolio equity'
    );
    this.peakEquity = this.ensureFinite(
      Math.max(this.peakEquity, equity),
      'peak equity'
    );
    const drawdown = this.ensureFinite(
      Math.max(0, this.peakEquity - equity),
      'drawdown'
    );
    const drawdownPercent = this.peakEquity > 0
      ? this.ensureFinite((drawdown / this.peakEquity) * 100, 'drawdown percent')
      : 0;

    return {
      totalPositions: positions.length,
      totalExposure,
      realizedPnL: this.ensureFinite(this.realizedPnL, 'realized pnl total'),
      unrealizedPnL,
      drawdown,
      drawdownPercent,
    };
  }

  getAccountBalance(): number {
    return this.accountBalance;
  }

  getConfig(): RiskConfig {
    return { ...this.config };
  }

  calculatePositionSize(balance: number, stopDistance: number): number {
    const safeBalance = this.ensureFinite(balance, 'position sizing balance');
    const safeStopDistance = this.ensureFinite(
      stopDistance,
      'position sizing stop distance'
    );

    if (safeBalance <= 0 || safeStopDistance <= 0) {
      throw new Error('Balance and stopDistance must be positive numbers');
    }

    const riskPerTrade =
      (this.config.maxRiskPerTradePercent / 100) * safeBalance;
    const rawSize = riskPerTrade / safeStopDistance;
    const positionSize = Math.max(0, rawSize);

    return this.ensureFinite(positionSize, 'position size');
  }

  validateRisk(): boolean {
    this.rollDayIfNeeded();
    const metrics = this.getRiskMetrics();
    const dailyLoss = this.ensureFinite(
      Math.max(0, -this.dailyRealizedPnL),
      'daily loss'
    );
    const dailyLossPercent =
      this.peakEquity > 0
        ? this.ensureFinite(
            (dailyLoss / this.peakEquity) * 100,
            'daily loss percent'
          )
        : 0;

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

    return this.ensureFinite(
      this.accountBalance + unrealizedPnL,
      'equity calculation'
    );
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

  private ensureFinite(value: number, label: string): number {
    if (Number.isFinite(value)) {
      return value;
    }

    logger.warn({ label, value }, 'Non-finite risk value encountered; clamping to 0');
    return 0;
  }
}
