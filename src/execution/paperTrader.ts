import logger from '../logger';
import type { OrderSide, OrderStatus } from './types';

export interface PaperTradeConfig {
  startingBalance: number;
  feePercent?: number; // e.g., 0.1% trading fee
}

export interface ExecutedTrade {
  id: string;
  symbol: string;
  side: OrderSide;
  price: number;
  quantity: number;
  notional: number;
  fee: number;
  pnl: number;
  timestamp: number;
  status: OrderStatus;
}

export class PaperTrader {
  private balance: number;
  private baseCurrencyBalance: number; // e.g., USD balance
  private quoteBalance: Record<string, number> = {}; // e.g., BTC balance by symbol
  private averageEntryPrice: Record<string, number> = {};
  private feePercent: number;
  private trades: ExecutedTrade[] = [];
  private tradeCounter = 0;

  constructor(config: PaperTradeConfig) {
    this.balance = config.startingBalance;
    this.baseCurrencyBalance = config.startingBalance;
    this.feePercent = config.feePercent ?? 0.001;

    logger.info(
      { startingBalance: this.balance, feePercent: this.feePercent },
      'PaperTrader initialized'
    );
  }

  getBalance(): number {
    return this.balance;
  }

  getQuoteBalance(symbol: string): number {
    return this.quoteBalance[symbol] ?? 0;
  }

  getTrades(): ExecutedTrade[] {
    return [...this.trades];
  }

  simulateOrder(symbol: string, side: OrderSide, price: number, quantity: number): ExecutedTrade {
    if (quantity <= 0 || price <= 0) {
      throw new Error('Price and quantity must be greater than 0');
    }

    const notional = price * quantity;
    const fee = notional * this.feePercent;
    let pnl = 0;
    let newStatus: OrderStatus = 'FILLED';

    if (side === 'BUY') {
      const cost = notional + fee;
      if (cost > this.baseCurrencyBalance) {
        throw new Error('Insufficient balance for BUY order');
      }

      this.baseCurrencyBalance -= cost;
      const existingQty = this.quoteBalance[symbol] ?? 0;
      const existingCostBasis = (this.averageEntryPrice[symbol] ?? 0) * existingQty;
      const newQty = existingQty + quantity;

      this.quoteBalance[symbol] = newQty;
      this.averageEntryPrice[symbol] = (existingCostBasis + notional) / newQty;
      this.balance = this.baseCurrencyBalance + this.liquidateQuotes(price); // base + quote value

      logger.info(
        { symbol, side, price, quantity, cost, fee, balance: this.balance },
        'Simulated BUY order'
      );
    } else {
      const availableQty = this.quoteBalance[symbol] ?? 0;

      if (quantity > availableQty) {
        throw new Error('Insufficient quote asset for SELL order');
      }

      const proceeds = notional - fee;
      const averageEntryPrice = this.averageEntryPrice[symbol] ?? price;
      this.quoteBalance[symbol] = availableQty - quantity;

      if (this.quoteBalance[symbol] === 0) {
        delete this.quoteBalance[symbol];
        delete this.averageEntryPrice[symbol];
      }

      this.baseCurrencyBalance += proceeds;
      this.balance = this.baseCurrencyBalance + this.liquidateQuotes(price);
      pnl = (price - averageEntryPrice) * quantity - fee;

      logger.info(
        { symbol, side, price, quantity, proceeds, fee, balance: this.balance, pnl },
        'Simulated SELL order'
      );
    }

    const trade: ExecutedTrade = {
      id: `PAPER_${++this.tradeCounter}`,
      symbol,
      side,
      price,
      quantity,
      notional,
      fee,
      pnl,
      timestamp: Date.now(),
      status: newStatus,
    };

    this.trades.push(trade);

    return trade;
  }

  private liquidateQuotes(latestPrice: number): number {
    // Estimate total value of all quote balances using the latest observed price.
    // This stays a single-price approximation until symbol-specific marks are tracked.
    const total = Object.entries(this.quoteBalance).reduce(
      (acc, [, qty]) => {
        return acc + qty * latestPrice;
      },
      0
    );

    return total;
  }

  getSummary(): {
    baseCurrencyBalance: number;
    totalBalance: number;
    tradesExecuted: number;
    tradeHistory: ExecutedTrade[];
  } {
    return {
      baseCurrencyBalance: this.baseCurrencyBalance,
      totalBalance: this.balance,
      tradesExecuted: this.trades.length,
      tradeHistory: this.getTrades(),
    };
  }
}
