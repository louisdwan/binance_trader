import type { CandleData } from '../marketData';
import type { StrategySignal, StrategyConfig } from './types';
import logger from '../logger';

export abstract class BaseStrategy {
  protected config: StrategyConfig;
  protected candles: CandleData[] = [];

  constructor(config: StrategyConfig) {
    this.config = config;
  }

  updateCandles(candles: CandleData[]): void {
    this.candles = candles;
  }

  abstract analyze(): StrategySignal;

  protected logAnalysis(signal: StrategySignal): void {
    logger.info(
      { signal, strategy: this.config.name },
      'Strategy analysis completed'
    );
  }

  getName(): string {
    return this.config.name;
  }

  isEnabled(): boolean {
    return this.config.enabled;
  }

  getConfig(): StrategyConfig {
    return this.config;
  }
}
