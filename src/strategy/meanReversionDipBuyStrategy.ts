import type { CandleData } from '../marketData';
import type { StrategyConfig, StrategySignal } from './types';
import { BaseStrategy } from './baseStrategy';

function calculateEMA(candles: CandleData[], period: number): number {
  if (candles.length < period) {
    return 0;
  }

  const smoothing = 2 / (period + 1);
  let ema =
    candles.slice(0, period).reduce((sum, candle) => sum + candle.close, 0) / period;

  for (let i = period; i < candles.length; i++) {
    ema = candles[i].close * smoothing + ema * (1 - smoothing);
  }

  return ema;
}

function calculateSMA(candles: CandleData[], period: number): number {
  if (candles.length < period) {
    return 0;
  }

  const window = candles.slice(-period);
  return window.reduce((sum, candle) => sum + candle.close, 0) / window.length;
}

function calculateStdDev(candles: CandleData[], period: number, mean: number): number {
  if (candles.length < period || mean === 0) {
    return 0;
  }

  const window = candles.slice(-period);
  const variance =
    window.reduce((sum, candle) => sum + (candle.close - mean) ** 2, 0) / window.length;
  return Math.sqrt(variance);
}

export class MeanReversionDipBuyStrategy extends BaseStrategy {
  private bandPeriod: number;
  private bandStdDevMultiplier: number;
  private trendPeriod: number;
  private reclaimPercent: number;

  constructor(config: StrategyConfig) {
    super(config);
    this.bandPeriod = config.parameters.bandPeriod || 20;
    this.bandStdDevMultiplier = config.parameters.bandStdDevMultiplier || 2;
    this.trendPeriod = config.parameters.trendPeriod || 200;
    this.reclaimPercent = config.parameters.reclaimPercent || 0.05;
  }

  analyze(): StrategySignal {
    const higherTimeframeCandles =
      (this.config.parameters.higherTimeframeCandles as CandleData[] | undefined) ?? [];

    if (
      this.candles.length < this.bandPeriod + 2 ||
      higherTimeframeCandles.length < this.trendPeriod
    ) {
      return {
        strategyName: this.getName(),
        action: 'HOLD',
        confidence: 0,
        reasoning: 'Insufficient data for mean reversion analysis',
      };
    }

    const currentCandle = this.candles[this.candles.length - 1];
    const previousCandle = this.candles[this.candles.length - 2];
    const basis = calculateSMA(this.candles, this.bandPeriod);
    const stdDev = calculateStdDev(this.candles, this.bandPeriod, basis);
    const lowerBand = basis - stdDev * this.bandStdDevMultiplier;
    const trendEma = calculateEMA(higherTimeframeCandles, this.trendPeriod);
    const higherTimeframePrice = higherTimeframeCandles[higherTimeframeCandles.length - 1].close;
    const trendSupportive = trendEma > 0 && higherTimeframePrice >= trendEma * 0.995;
    const dippedBelowBand =
      previousCandle.low < lowerBand || currentCandle.low < lowerBand;
    const reclaimedBand =
      currentCandle.close >= lowerBand * (1 + this.reclaimPercent / 100);
    const bullishResponse =
      currentCandle.close > currentCandle.open &&
      currentCandle.close > previousCandle.close;
    const bandDistancePercent =
      basis > 0 ? ((basis - currentCandle.close) / basis) * 100 : 0;
    const diagnostics = {
      basis,
      stdDev,
      lowerBand,
      trendEma,
      higherTimeframePrice,
      trendSupportive,
      dippedBelowBand,
      reclaimedBand,
      bullishResponse,
      bandDistancePercent,
      reclaimPercent: this.reclaimPercent,
      bandStdDevMultiplier: this.bandStdDevMultiplier,
    };

    if (trendSupportive && dippedBelowBand && reclaimedBand && bullishResponse) {
      const excursionQuality = Math.min(
        1,
        Math.max(0, ((lowerBand - Math.min(previousCandle.low, currentCandle.low)) / Math.max(lowerBand, 1)) * 100 * 8)
      );
      const reclaimQuality = currentCandle.close > basis ? 1 : 0.75;
      const confidence = Math.min(1, excursionQuality * 0.4 + reclaimQuality * 0.3 + 0.3);

      const signal: StrategySignal = {
        strategyName: this.getName(),
        action: 'BUY',
        confidence,
        reasoning: 'Price mean-reverted from a lower-band flush and reclaimed support while the higher timeframe stayed constructive',
        diagnostics,
      };

      this.logAnalysis(signal);
      return signal;
    }

    const signal: StrategySignal = {
      strategyName: this.getName(),
      action: 'HOLD',
      confidence: 0,
      reasoning: trendSupportive
        ? 'Trend is constructive, but the dip-buy reclaim is not complete'
        : 'Higher-timeframe trend is too weak for a mean-reversion entry',
      diagnostics,
    };

    this.logAnalysis(signal);
    return signal;
  }
}
