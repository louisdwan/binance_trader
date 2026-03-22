import type { CandleData } from '../marketData';

export interface EMASignal {
  action: 'BUY' | 'NO_TRADE';
  confidence: number;
  reason: string;
  currentPrice: number;
  ema20: number;
  ema200: number;
  priceAboveEMA200: boolean;
  priceNearEMA20: boolean;
  timestamp: number;
}

/**
 * Calculate Exponential Moving Average
 * @param data Array of candle data
 * @param period Number of periods for EMA calculation
 * @returns EMA value
 */
function calculateEMA(data: CandleData[], period: number): number {
  if (data.length < period) {
    return 0;
  }

  const k = 2 / (period + 1);
  let ema = 0;

  // Calculate SMA for first period
  let sum = 0;
  for (let i = 0; i < period; i++) {
    sum += data[i].close;
  }
  ema = sum / period;

  // Calculate EMA for remaining data
  for (let i = period; i < data.length; i++) {
    ema = data[i].close * k + ema * (1 - k);
  }

  return ema;
}

/**
 * Check if price is near EMA (within 0.5% tolerance)
 */
function priceNearEMA(price: number, ema: number, tolerance: number = 0.005): boolean {
  if (ema === 0) return false;
  const diff = Math.abs(price - ema) / ema;
  return diff <= tolerance;
}

/**
 * EMA-based Trading Strategy
 * Signals BUY when:
 * - Price is above 200 EMA (trend confirmation)
 * - Price pulls back to 20 EMA (entry point)
 */
export class EMAStrategy {
  private period20: number = 20;
  private period200: number = 200;
  private tolerance: number = 0.005; // 0.5% tolerance for "near EMA20"

  /**
   * Analyze candles and generate trading signal
   * @param candles Array of candle data (must have at least 200 candles for 200 EMA)
   * @returns EMA signal with action and reasoning
   */
  analyze(candles: CandleData[]): EMASignal {
    const timestamp = Date.now();

    // Validate minimum data
    if (candles.length < this.period200) {
      return {
        action: 'NO_TRADE',
        confidence: 0,
        reason: `Insufficient data: ${candles.length} candles available, need minimum ${this.period200}`,
        currentPrice: candles.length > 0 ? candles[candles.length - 1].close : 0,
        ema20: 0,
        ema200: 0,
        priceAboveEMA200: false,
        priceNearEMA20: false,
        timestamp,
      };
    }

    // Calculate EMAs
    const ema20 = calculateEMA(candles, this.period20);
    const ema200 = calculateEMA(candles, this.period200);

    if (ema20 === 0 || ema200 === 0) {
      return {
        action: 'NO_TRADE',
        confidence: 0,
        reason: 'EMA calculation failed',
        currentPrice: candles[candles.length - 1].close,
        ema20,
        ema200,
        priceAboveEMA200: false,
        priceNearEMA20: false,
        timestamp,
      };
    }

    const currentPrice = candles[candles.length - 1].close;
    const priceAboveEMA200 = currentPrice > ema200;
    const priceNearEMA20 = priceNearEMA(currentPrice, ema20, this.tolerance);

    // BUY signals logic
    if (priceAboveEMA200 && priceNearEMA20) {
      // Calculate confidence based on how close price is to EMA20
      const priceDeviation = Math.abs(currentPrice - ema20) / ema20;
      const confidence = Math.max(0, 1 - priceDeviation * 100); // Closer = higher confidence

      return {
        action: 'BUY',
        confidence: Math.min(confidence, 1),
        reason: `Strong buy signal: Price ($${currentPrice.toFixed(2)}) above 200 EMA ($${ema200.toFixed(2)}) and pulled back to 20 EMA ($${ema20.toFixed(2)})`,
        currentPrice,
        ema20,
        ema200,
        priceAboveEMA200,
        priceNearEMA20,
        timestamp,
      };
    }

    // Determine NO_TRADE reason
    let noTradeReason = '';
    if (!priceAboveEMA200) {
      noTradeReason = `Price ($${currentPrice.toFixed(2)}) is below 200 EMA ($${ema200.toFixed(2)}). Trend not confirmed.`;
    } else if (!priceNearEMA20) {
      const distancePercent = ((currentPrice - ema20) / ema20 * 100).toFixed(2);
      noTradeReason = `Price ($${currentPrice.toFixed(2)}) is ${distancePercent}% above 20 EMA ($${ema20.toFixed(2)}). Waiting for pullback.`;
    }

    return {
      action: 'NO_TRADE',
      confidence: 0,
      reason: noTradeReason || 'No trade conditions met',
      currentPrice,
      ema20,
      ema200,
      priceAboveEMA200,
      priceNearEMA20,
      timestamp,
    };
  }

  /**
   * Set custom EMA periods
   */
  setPeriods(period20: number, period200: number): void {
    this.period20 = period20;
    this.period200 = period200;
  }

  /**
   * Set price proximity tolerance for entry (default 0.5%)
   */
  setTolerance(tolerance: number): void {
    this.tolerance = tolerance;
  }

  /**
   * Get current EMA periods
   */
  getPeriods(): { period20: number; period200: number } {
    return {
      period20: this.period20,
      period200: this.period200,
    };
  }
}
