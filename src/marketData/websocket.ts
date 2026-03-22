import WebSocket from 'ws';
import { EventEmitter } from 'events';
import logger from '../logger';

export interface PriceUpdate {
  symbol: string;
  price: number;
  timestamp: number;
  bid: number;
  ask: number;
  volume: number;
}

export interface WebSocketConfig {
  baseURL?: string;
  reconnectInterval?: number;
  maxReconnectAttempts?: number;
  heartbeatInterval?: number;
}

export class BinanceWebSocket extends EventEmitter {
  private ws: WebSocket | null = null;
  private baseURL: string;
  private reconnectInterval: number;
  private maxReconnectAttempts: number;
  private currentReconnectAttempts: number = 0;
  private heartbeatInterval: number;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private symbols: Set<string> = new Set();
  private isIntentionallyClosed: boolean = false;

  constructor(config: WebSocketConfig = {}) {
    super();
    this.baseURL = config.baseURL || 'wss://stream.binance.com:9443/ws';
    this.reconnectInterval = config.reconnectInterval || 5000;
    this.maxReconnectAttempts = config.maxReconnectAttempts || 10;
    this.heartbeatInterval = config.heartbeatInterval || 30000;
  }

  connect(symbols: string[] = ['btcusdt']): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      logger.warn('WebSocket already connected');
      return;
    }

    this.isIntentionallyClosed = false;
    this.symbols = new Set(symbols.map((s) => s.toLowerCase()));

    const streams = Array.from(this.symbols)
      .map((symbol) => `${symbol}@ticker`)
      .join('/');

    const url = `${this.baseURL}/${streams}`;

    logger.info({ url, symbols: Array.from(this.symbols) }, 'Connecting to Binance WebSocket');

    try {
      this.ws = new WebSocket(url);

      this.ws.on('open', () => this.handleOpen());
      this.ws.on('message', (data) => this.handleMessage(data.toString()));
      this.ws.on('error', (error) => this.handleError(error));
      this.ws.on('close', () => this.handleClose());
    } catch (error) {
      logger.error({ error }, 'Failed to create WebSocket connection');
      this.scheduleReconnect();
    }
  }

  disconnect(): void {
    logger.info('Disconnecting WebSocket');
    this.isIntentionallyClosed = true;

    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }

    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }

    this.currentReconnectAttempts = 0;
  }

  subscribe(symbols: string[]): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      logger.warn('WebSocket not connected');
      return;
    }

    const newSymbols = symbols.map((s) => s.toLowerCase());
    const toSubscribe = newSymbols.filter((s) => !this.symbols.has(s));

    if (toSubscribe.length === 0) {
      return;
    }

    const params = toSubscribe.map((symbol) => `${symbol}@ticker`);

    const message = {
      method: 'SUBSCRIBE',
      params,
      id: Date.now(),
    };

    try {
      this.ws.send(JSON.stringify(message));
      toSubscribe.forEach((symbol) => this.symbols.add(symbol));
      logger.info({ symbols: toSubscribe }, 'Subscribed to symbols');
    } catch (error) {
      logger.error({ error }, 'Failed to subscribe to symbols');
    }
  }

  unsubscribe(symbols: string[]): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      logger.warn('WebSocket not connected');
      return;
    }

    const toUnsubscribe = symbols
      .map((s) => s.toLowerCase())
      .filter((s) => this.symbols.has(s));

    if (toUnsubscribe.length === 0) {
      return;
    }

    const params = toUnsubscribe.map((symbol) => `${symbol}@ticker`);

    const message = {
      method: 'UNSUBSCRIBE',
      params,
      id: Date.now(),
    };

    try {
      this.ws.send(JSON.stringify(message));
      toUnsubscribe.forEach((symbol) => this.symbols.delete(symbol));
      logger.info({ symbols: toUnsubscribe }, 'Unsubscribed from symbols');
    } catch (error) {
      logger.error({ error }, 'Failed to unsubscribe from symbols');
    }
  }

  private handleOpen(): void {
    logger.info('WebSocket connection established');
    this.currentReconnectAttempts = 0;
    this.startHeartbeat();
    this.emit('connected');
  }

  private handleMessage(data: string): void {
    try {
      const parsed = JSON.parse(data);

      // Skip non-ticker messages
      if (!parsed.e || parsed.e !== '24hrTicker') {
        return;
      }

      const update: PriceUpdate = {
        symbol: parsed.s,
        price: parseFloat(parsed.c),
        timestamp: parsed.E,
        bid: parseFloat(parsed.b),
        ask: parseFloat(parsed.a),
        volume: parseFloat(parsed.v),
      };

      // Log to console with formatted output
      console.log(
        `[${new Date(update.timestamp).toISOString()}] ${update.symbol}: $${update.price.toFixed(2)} (Bid: $${update.bid.toFixed(2)}, Ask: $${update.ask.toFixed(2)}) | Vol: ${(update.volume / 1000).toFixed(0)}K`
      );

      logger.debug({ update }, 'Price update received');
      this.emit('price', update);
    } catch (error) {
      logger.warn({ error, data }, 'Failed to parse WebSocket message');
    }
  }

  private handleError(error: Error): void {
    logger.error({ error }, 'WebSocket error');
    this.emit('error', error);
  }

  private handleClose(): void {
    logger.info('WebSocket connection closed');

    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }

    this.ws = null;

    if (!this.isIntentionallyClosed) {
      this.scheduleReconnect();
    }

    this.emit('disconnected');
  }

  private startHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
    }

    this.heartbeatTimer = setInterval(() => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        try {
          this.ws.ping();
          logger.debug('WebSocket heartbeat sent');
        } catch (error) {
          logger.warn({ error }, 'Failed to send heartbeat');
        }
      }
    }, this.heartbeatInterval);
  }

  private scheduleReconnect(): void {
    if (this.currentReconnectAttempts >= this.maxReconnectAttempts) {
      logger.error(
        { attempts: this.currentReconnectAttempts },
        'Max reconnection attempts reached'
      );
      this.emit('max_reconnect_attempts_reached');
      return;
    }

    this.currentReconnectAttempts++;
    const delay = this.reconnectInterval * this.currentReconnectAttempts;

    logger.info(
      { attempt: this.currentReconnectAttempts, delay },
      'Scheduling reconnection'
    );

    setTimeout(() => {
      if (!this.isIntentionallyClosed) {
        this.connect(Array.from(this.symbols));
      }
    }, delay);
  }

  isConnected(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }

  getConnectedSymbols(): string[] {
    return Array.from(this.symbols);
  }
}
