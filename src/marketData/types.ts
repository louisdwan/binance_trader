export interface CandleData {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface Ticker {
  symbol: string;
  price: number;
  timestamp: number;
  bid: number;
  ask: number;
}

export interface OrderBook {
  symbol: string;
  bids: Array<[number, number]>;
  asks: Array<[number, number]>;
  timestamp: number;
}
