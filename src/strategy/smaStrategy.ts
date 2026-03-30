import type { CandleData } from '../marketData';
import type { StrategySignal, StrategyConfig } from './types';
import { BaseStrategy } from './baseStrategy';

export class SimpleMovingAverageStrategy extends BaseStrategy {
  private fastPeriod: number;
  private slowPeriod: number;

  constructor(config: StrategyConfig) {
    super(config);
    this.fastPeriod = config.parameters.fastPeriod || 5;
    this.slowPeriod = config.parameters.slowPeriod || 20;
  }

  private calculateSMA(candles: CandleData[], period: number): number {
    if (candles.length < period) return 0;

    const sum = candles
      .slice(-period)
      .reduce((acc, candle) => acc + candle.close, 0);
    return sum / period;
  }

  analyze(): StrategySignal {
    const fastSMA = this.calculateSMA(this.candles, this.fastPeriod);
    const slowSMA = this.calculateSMA(this.candles, this.slowPeriod);

    if (fastSMA === 0 || slowSMA === 0) {
      return {
        strategyName: this.getName(),
        action: 'HOLD',
        confidence: 0,
        reasoning: 'Insufficient data for analysis',
      };
    }

    const currentPrice = this.candles[this.candles.length - 1].close;
    const diff = fastSMA - slowSMA;
    const crossoverStrength = slowSMA !== 0 ? Math.abs(diff / slowSMA) * 100 : 0;
    const confidence = Math.min(crossoverStrength, 1);

    let action: 'BUY' | 'SELL' | 'HOLD' = 'HOLD';
    let reasoning = '';

    if (fastSMA > slowSMA) {
      action = 'BUY';
      reasoning = `Fast SMA (${fastSMA.toFixed(2)}) > Slow SMA (${slowSMA.toFixed(2)})`;
    } else if (fastSMA < slowSMA) {
      action = 'SELL';
      reasoning = `Fast SMA (${fastSMA.toFixed(2)}) < Slow SMA (${slowSMA.toFixed(2)})`;
    }

    const signal: StrategySignal = {
      strategyName: this.getName(),
      action,
      confidence,
      reasoning,
    };

    this.logAnalysis(signal);
    return signal;
  }
}
