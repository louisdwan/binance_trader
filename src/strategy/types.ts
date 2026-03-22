export interface StrategySignal {
  action: 'BUY' | 'SELL' | 'HOLD';
  confidence: number;
  reasoning: string;
}

export interface StrategyConfig {
  name: string;
  symbol: string;
  enabled: boolean;
  parameters: Record<string, any>;
}
