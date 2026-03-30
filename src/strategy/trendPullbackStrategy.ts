import type { CandleData } from '../marketData';
import type { StrategySignal, StrategyConfig } from './types';
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

export class TrendPullbackStrategy extends BaseStrategy {
  private trendPeriod: number;
  private fastPeriod: number;
  private pullbackPeriod: number;
  private pullbackTolerancePercent: number;
  private trendBufferPercent: number;
  private minTrendStrengthPercent: number;

  constructor(config: StrategyConfig) {
    super(config);
    this.trendPeriod = config.parameters.trendPeriod || 200;
    this.fastPeriod = config.parameters.fastPeriod || 5;
    this.pullbackPeriod = config.parameters.pullbackPeriod || 20;
    this.pullbackTolerancePercent =
      config.parameters.pullbackTolerancePercent || 0.15;
    this.trendBufferPercent = config.parameters.trendBufferPercent || 0.2;
    this.minTrendStrengthPercent =
      config.parameters.minTrendStrengthPercent || 0.03;
  }

  analyze(): StrategySignal {
    const higherTimeframeCandles =
      (this.config.parameters.higherTimeframeCandles as CandleData[] | undefined) ?? [];

    if (
      this.candles.length < this.pullbackPeriod ||
      higherTimeframeCandles.length < this.trendPeriod + 1
    ) {
      return {
        strategyName: this.getName(),
        action: 'HOLD',
        confidence: 0,
        reasoning: 'Insufficient data for trend pullback analysis',
        diagnostics: {
          enough1mCandles: this.candles.length >= this.pullbackPeriod,
          enough15mCandles: higherTimeframeCandles.length >= this.trendPeriod + 1,
          candleCount1m: this.candles.length,
          candleCount15m: higherTimeframeCandles.length,
        },
      };
    }

    const emaFast = calculateEMA(this.candles, this.fastPeriod);
    const emaPullback = calculateEMA(this.candles, this.pullbackPeriod);
    const trendEma = calculateEMA(higherTimeframeCandles, this.trendPeriod);
    const previousTrendEma = calculateEMA(
      higherTimeframeCandles.slice(0, -1),
      this.trendPeriod
    );

    if (
      emaFast === 0 ||
      emaPullback === 0 ||
      trendEma === 0 ||
      previousTrendEma === 0
    ) {
      return {
        strategyName: this.getName(),
        action: 'HOLD',
        confidence: 0,
        reasoning: 'Unable to calculate EMA inputs',
        diagnostics: {
          emaFast,
          emaPullback,
          trendEma,
          previousTrendEma,
        },
      };
    }

    const currentCandle = this.candles[this.candles.length - 1];
    const previousCandle = this.candles[this.candles.length - 2];
    const currentPrice = currentCandle.close;
    const higherTimeframePrice =
      higherTimeframeCandles[higherTimeframeCandles.length - 1].close;
    const trendStrengthPercent = Math.abs((trendEma - previousTrendEma) / previousTrendEma) * 100;

    const trendBufferMultiplier = this.trendBufferPercent / 100;
    const trendUp =
      higherTimeframePrice > trendEma * (1 + trendBufferMultiplier) &&
      trendEma > previousTrendEma &&
      trendStrengthPercent >= this.minTrendStrengthPercent;
    const trendDown =
      higherTimeframePrice < trendEma * (1 - trendBufferMultiplier) &&
      trendEma < previousTrendEma &&
      trendStrengthPercent >= this.minTrendStrengthPercent;
    const pullbackDistancePercent =
      (Math.abs(currentPrice - emaPullback) / emaPullback) * 100;
    const touchedPullbackZone =
      currentCandle.low <= emaPullback * (1 + this.pullbackTolerancePercent / 100) ||
      previousCandle.low <= emaPullback * (1 + this.pullbackTolerancePercent / 100);
    const pulledBelowFast =
      previousCandle.close <= emaFast || previousCandle.low <= emaFast;
    const resumedUp =
      currentPrice > emaFast &&
      currentPrice > previousCandle.close &&
      currentCandle.close > currentCandle.open;
    const closedBackAbovePullback = currentPrice >= emaPullback;
    const pullbackIsTight =
      pullbackDistancePercent <= this.pullbackTolerancePercent * 1.5;
    const diagnostics = {
      emaFast,
      emaPullback,
      trendEma,
      previousTrendEma,
      currentPrice,
      higherTimeframePrice,
      trendStrengthPercent,
      pullbackDistancePercent,
      trendUp,
      trendDown,
      fastAbovePullback: emaFast > emaPullback,
      touchedPullbackZone,
      pulledBelowFast,
      resumedUp,
      closedBackAbovePullback,
      pullbackIsTight,
      trendBufferPercent: this.trendBufferPercent,
      minTrendStrengthPercent: this.minTrendStrengthPercent,
      pullbackTolerancePercent: this.pullbackTolerancePercent,
    };

    if (
      trendUp &&
      emaFast > emaPullback &&
      touchedPullbackZone &&
      pulledBelowFast &&
      resumedUp &&
      closedBackAbovePullback &&
      pullbackIsTight
    ) {
      const trendStrength = Math.min(
        trendStrengthPercent / this.minTrendStrengthPercent / 3,
        1
      );
      const pullbackQuality = Math.max(
        0,
        1 - pullbackDistancePercent / (this.pullbackTolerancePercent * 1.5)
      );
      const reclaimQuality = currentPrice > previousCandle.high ? 1 : 0.7;
      const confidence = Math.min(
        1,
        trendStrength * 0.45 + pullbackQuality * 0.35 + reclaimQuality * 0.2
      );

      const signal: StrategySignal = {
        strategyName: this.getName(),
        action: 'BUY',
        confidence,
        reasoning:
          `15m trend is up above EMA${this.trendPeriod}, and 1m price pulled back ` +
          `toward EMA${this.pullbackPeriod} before reclaiming EMA${this.fastPeriod} with bullish follow-through`,
        diagnostics,
      };

      this.logAnalysis(signal);
      return signal;
    }

    if (trendDown) {
      const signal: StrategySignal = {
        strategyName: this.getName(),
        action: 'SELL',
        confidence: Math.min(
          1,
          Math.abs((higherTimeframePrice - trendEma) / trendEma) * 100
        ),
        reasoning:
          `15m trend is below EMA${this.trendPeriod} by more than ` +
          `${this.trendBufferPercent}% with a weakening EMA slope`,
        diagnostics,
      };

      this.logAnalysis(signal);
      return signal;
    }

    const signal: StrategySignal = {
      strategyName: this.getName(),
      action: 'HOLD',
      confidence: 0,
      reasoning:
        trendUp
          ? 'Trend is up, but the 1m pullback entry is not ready'
          : `15m trend is inside the neutral zone around EMA${this.trendPeriod}`,
      diagnostics,
    };

    this.logAnalysis(signal);
    return signal;
  }
}
