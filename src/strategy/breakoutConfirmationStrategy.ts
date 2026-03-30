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

function averageVolume(candles: CandleData[]): number {
  if (candles.length === 0) {
    return 0;
  }

  return candles.reduce((sum, candle) => sum + candle.volume, 0) / candles.length;
}

export class BreakoutConfirmationStrategy extends BaseStrategy {
  private breakoutLookback: number;
  private volumeLookback: number;
  private breakoutBufferPercent: number;
  private volumeMultiplier: number;
  private trendPeriod: number;

  constructor(config: StrategyConfig) {
    super(config);
    this.breakoutLookback = config.parameters.breakoutLookback || 20;
    this.volumeLookback = config.parameters.volumeLookback || 20;
    this.breakoutBufferPercent = config.parameters.breakoutBufferPercent || 0.05;
    this.volumeMultiplier = config.parameters.volumeMultiplier || 1.2;
    this.trendPeriod = config.parameters.trendPeriod || 200;
  }

  analyze(): StrategySignal {
    const higherTimeframeCandles =
      (this.config.parameters.higherTimeframeCandles as CandleData[] | undefined) ?? [];

    if (
      this.candles.length < this.breakoutLookback + 1 ||
      this.candles.length < this.volumeLookback + 1 ||
      higherTimeframeCandles.length < this.trendPeriod
    ) {
      return {
        strategyName: this.getName(),
        action: 'HOLD',
        confidence: 0,
        reasoning: 'Insufficient data for breakout analysis',
      };
    }

    const currentCandle = this.candles[this.candles.length - 1];
    const previousCandles = this.candles.slice(-(this.breakoutLookback + 1), -1);
    const volumeCandles = this.candles.slice(-this.volumeLookback);
    const breakoutLevel = Math.max(...previousCandles.map((candle) => candle.high));
    const averageBreakoutVolume = averageVolume(volumeCandles);
    const trendEma = calculateEMA(higherTimeframeCandles, this.trendPeriod);
    const previousTrendEma = calculateEMA(higherTimeframeCandles.slice(0, -1), this.trendPeriod);
    const higherTimeframePrice = higherTimeframeCandles[higherTimeframeCandles.length - 1].close;
    const breakoutDistancePercent =
      breakoutLevel > 0 ? ((currentCandle.close - breakoutLevel) / breakoutLevel) * 100 : 0;
    const breakoutConfirmed =
      currentCandle.close > breakoutLevel * (1 + this.breakoutBufferPercent / 100);
    const volumeConfirmed =
      averageBreakoutVolume > 0 &&
      currentCandle.volume >= averageBreakoutVolume * this.volumeMultiplier;
    const trendUp =
      trendEma > 0 &&
      previousTrendEma > 0 &&
      higherTimeframePrice > trendEma &&
      trendEma >= previousTrendEma;
    const diagnostics = {
      breakoutLevel,
      breakoutDistancePercent,
      breakoutConfirmed,
      currentVolume: currentCandle.volume,
      averageBreakoutVolume,
      volumeConfirmed,
      trendEma,
      previousTrendEma,
      higherTimeframePrice,
      trendUp,
      breakoutBufferPercent: this.breakoutBufferPercent,
      volumeMultiplier: this.volumeMultiplier,
    };

    if (breakoutConfirmed && volumeConfirmed && trendUp) {
      const breakoutQuality = Math.min(
        1,
        breakoutDistancePercent / Math.max(this.breakoutBufferPercent * 2, 0.01)
      );
      const volumeQuality = Math.min(
        1,
        currentCandle.volume / Math.max(averageBreakoutVolume * this.volumeMultiplier, 1)
      );
      const confidence = Math.min(1, breakoutQuality * 0.55 + volumeQuality * 0.25 + 0.2);

      const signal: StrategySignal = {
        strategyName: this.getName(),
        action: 'BUY',
        confidence,
        reasoning: 'Price broke above recent highs with volume confirmation in an upward higher-timeframe trend',
        diagnostics,
      };

      this.logAnalysis(signal);
      return signal;
    }

    const signal: StrategySignal = {
      strategyName: this.getName(),
      action: 'HOLD',
      confidence: 0,
      reasoning: trendUp
        ? 'Trend is supportive, but breakout confirmation is not complete'
        : 'Higher-timeframe trend does not support breakout continuation',
      diagnostics,
    };

    this.logAnalysis(signal);
    return signal;
  }
}
