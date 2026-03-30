export interface StrategyDiagnostics {
  [key: string]: boolean | number | string | null | undefined;
}

export interface StrategySignal {
  strategyName: string;
  action: 'BUY' | 'SELL' | 'HOLD';
  confidence: number;
  reasoning: string;
  diagnostics?: StrategyDiagnostics;
}

export interface StrategyConfig {
  type: 'trend_pullback' | 'breakout_confirmation' | 'mean_reversion_dip_buy';
  name: string;
  symbol: string;
  enabled: boolean;
  parameters: Record<string, any>;
}
