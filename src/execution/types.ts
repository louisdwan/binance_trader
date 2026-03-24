export type OrderType = 'LIMIT' | 'MARKET' | 'STOP_LOSS' | 'TAKE_PROFIT';
export type OrderSide = 'BUY' | 'SELL';
export type OrderStatus = 'PENDING' | 'OPEN' | 'FILLED' | 'CANCELLED' | 'FAILED';

export interface Order {
  id?: string;
  symbol: string;
  side: OrderSide;
  type: OrderType;
  quantity: number;
  price?: number;
  stopPrice?: number;
  status: OrderStatus;
  timestamp: number;
  filledQuantity?: number;
  averagePrice?: number;
}

export interface ExecutionConfig {
  apiKey: string;
  apiSecret: string;
  baseURL?: string;
  testnet?: boolean;
  dryRun?: boolean;
  recvWindow?: number;
}

export interface AccountBalance {
  asset: string;
  free: number;
  locked: number;
}

export interface AccountInfo {
  canTrade: boolean;
  canWithdraw: boolean;
  canDeposit: boolean;
  updateTime: number;
  balances: AccountBalance[];
}
