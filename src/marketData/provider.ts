import axios from 'axios';
import logger from '../logger';
import type { Ticker, OrderBook, CandleData } from './types';

export class MarketDataProvider {
  private baseURL: string;

  constructor(baseURL: string = 'https://api.binance.com/api/v3') {
    this.baseURL = baseURL;
  }

  async getTicker(symbol: string): Promise<Ticker> {
    try {
      const response = await axios.get(`${this.baseURL}/ticker/24hr`, {
        params: { symbol },
      });

      return {
        symbol: response.data.symbol,
        price: parseFloat(response.data.lastPrice),
        timestamp: response.data.time,
        bid: parseFloat(response.data.bidPrice),
        ask: parseFloat(response.data.askPrice),
      };
    } catch (error) {
      logger.error({ error, symbol }, 'Failed to fetch ticker');
      throw error;
    }
  }

  async getOrderBook(
    symbol: string,
    limit: number = 20
  ): Promise<OrderBook> {
    try {
      const response = await axios.get(`${this.baseURL}/depth`, {
        params: { symbol, limit },
      });

      return {
        symbol,
        bids: response.data.bids.map((bid: string[]) => [
          parseFloat(bid[0]),
          parseFloat(bid[1]),
        ]),
        asks: response.data.asks.map((ask: string[]) => [
          parseFloat(ask[0]),
          parseFloat(ask[1]),
        ]),
        timestamp: Date.now(),
      };
    } catch (error) {
      logger.error({ error, symbol }, 'Failed to fetch order book');
      throw error;
    }
  }

  async getCandles(
    symbol: string,
    interval: string = '1h',
    limit: number = 100
  ): Promise<CandleData[]> {
    try {
      const response = await axios.get(`${this.baseURL}/klines`, {
        params: { symbol, interval, limit },
      });

      return response.data.map((candle: any[]) => ({
        timestamp: candle[0],
        open: parseFloat(candle[1]),
        high: parseFloat(candle[2]),
        low: parseFloat(candle[3]),
        close: parseFloat(candle[4]),
        volume: parseFloat(candle[7]),
      }));
    } catch (error) {
      logger.error({ error, symbol, interval }, 'Failed to fetch candles');
      throw error;
    }
  }
}

export default new MarketDataProvider();
