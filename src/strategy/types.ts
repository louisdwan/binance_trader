export interface StrategyDiagnostics {
  [key: string]: boolean | number | string | null | undefined;
}

export interface StrategySignal {
  action: 'BUY' | 'SELL' | 'HOLD';
  confidence: number;
  reasoning: string;
  diagnostics?: StrategyDiagnostics;
}

export interface StrategyConfig {
  name: string;
  symbol: string;
  enabled: boolean;
  parameters: Record<string, any>;
}
