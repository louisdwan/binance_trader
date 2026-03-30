import axios, { type AxiosResponse } from 'axios';
import crypto from 'crypto';
import logger from '../logger';
import type { Order, ExecutionConfig, AccountBalance, AccountInfo } from './types';

type ExchangeInfoSymbol = {
  symbol: string;
  status: string;
  baseAsset: string;
  quoteAsset: string;
  filters: Array<Record<string, string>>;
};

type SymbolTradingRules = {
  symbol: string;
  status: string;
  baseAsset: string;
  quoteAsset: string;
  minQty: number;
  maxQty: number;
  stepSize: number;
  minNotional: number;
  tickSize: number;
};

type PreparedOrder = Order & {
  id: string;
  timestamp: number;
};

type BinanceErrorPayload = {
  code?: number;
  msg?: string;
};

type ServerTimeOffset = {
  offsetMs: number;
  syncedAt: number;
};

export class OrderExecutor {
  private static readonly serverTimeCacheTtlMs = 60_000;
  private static readonly pendingOrderStaleAfterMs = 5 * 60 * 1000;
  private static readonly serverTimeOffsets = new Map<string, ServerTimeOffset>();
  private config: ExecutionConfig;
  private orders: Map<string, Order> = new Map();
  private orderCounter: number = 0;
  private symbolRulesCache: Map<string, SymbolTradingRules> = new Map();

  constructor(config: ExecutionConfig) {
    this.config = {
      recvWindow: config.recvWindow ?? 5000,
      dryRun: config.dryRun ?? true,
      ...config,
    };
    logger.info(
      {
        testnet: this.config.testnet,
        dryRun: this.config.dryRun,
      },
      'OrderExecutor initialized'
    );
  }

  async executeOrder(order: Omit<Order, 'id' | 'timestamp'>): Promise<Order> {
    const preparedOrder = await this.prepareOrder(order);
    this.orders.set(preparedOrder.id, preparedOrder);

    try {
      let executedOrder: PreparedOrder;

      if (this.config.dryRun) {
        executedOrder = await this.simulateOrderExecution(preparedOrder);
      } else {
        executedOrder = await this.placeBinanceOrder(preparedOrder);
      }

      this.orders.set(executedOrder.id as string, executedOrder);
      logger.info(
        {
          orderId: executedOrder.id,
          symbol: executedOrder.symbol,
          side: executedOrder.side,
          type: executedOrder.type,
          dryRun: this.config.dryRun,
        },
        'Order executed successfully'
      );

      return executedOrder;
    } catch (error) {
      preparedOrder.status = 'FAILED';
      this.orders.set(preparedOrder.id, preparedOrder);
      logger.error({ error, orderId: preparedOrder.id }, 'Order execution failed');
      throw error;
    }
  }

  async prepareOrder(order: Omit<Order, 'id' | 'timestamp'>): Promise<PreparedOrder> {
    const executedOrder: PreparedOrder = {
      ...order,
      id: this.generateOrderId(),
      timestamp: Date.now(),
      status: order.status ?? 'PENDING',
    };

    return this.normalizeOrder(executedOrder);
  }

  async cancelOrder(orderId: string): Promise<Order> {
    const order = this.orders.get(orderId);

    if (!order) {
      throw new Error(`Order ${orderId} not found`);
    }

    if (order.status === 'FILLED' || order.status === 'FAILED') {
      throw new Error(`Order ${orderId} cannot be cancelled from status ${order.status}`);
    }

    if (order.status === 'CANCELLED') {
      return order;
    }

    order.status = 'CANCELLED';
    logger.info({ orderId }, 'Order cancelled');

    return order;
  }

  getOrder(orderId: string): Order | undefined {
    return this.orders.get(orderId);
  }

  getAllOrders(): Order[] {
    return Array.from(this.orders.values());
  }

  restoreOrders(orders: Order[]): void {
    this.orders = new Map(
      orders.map((order) => [String(order.id), { ...order }])
    );
    this.orderCounter = orders.length;
    logger.info({ orderCount: orders.length }, 'Order executor restored from persisted state');
  }

  getOpenOrders(): Order[] {
    const now = Date.now();
    return Array.from(this.orders.values()).filter(
      (order) =>
        order.status === 'OPEN' ||
        (order.status === 'PENDING' &&
          now - order.timestamp <= OrderExecutor.pendingOrderStaleAfterMs)
    );
  }

  async getAccountInfo(): Promise<AccountInfo> {
    return OrderExecutor.fetchAccountInfo(this.config);
  }

  async getAssetBalance(asset: string): Promise<AccountBalance | null> {
    const accountInfo = await this.getAccountInfo();
    return (
      accountInfo.balances.find(
        (balance) => balance.asset.toUpperCase() === asset.toUpperCase()
      ) ?? null
    );
  }

  static async fetchAccountInfo(config: ExecutionConfig): Promise<AccountInfo> {
    if (!config.apiKey || !config.apiSecret) {
      throw new Error('Missing Binance API credentials');
    }

    const recvWindow = config.recvWindow ?? 5000;
    const response = await OrderExecutor.sendSignedRequest<any>(config, 'GET', '/account', {
      recvWindow: String(recvWindow),
    });

    return {
      canTrade: response.data.canTrade,
      canWithdraw: response.data.canWithdraw,
      canDeposit: response.data.canDeposit,
      updateTime: response.data.updateTime,
      balances: (response.data.balances ?? []).map((balance: any) => ({
        asset: balance.asset,
        free: Number(balance.free),
        locked: Number(balance.locked),
      })),
    };
  }

  async getSymbolTradingRules(symbol: string): Promise<SymbolTradingRules> {
    const normalizedSymbol = symbol.toUpperCase();
    const cachedRules = this.symbolRulesCache.get(normalizedSymbol);
    if (cachedRules) {
      return cachedRules;
    }

    const baseURL = OrderExecutor.getBaseURL(this.config);
    const response = await axios.get(`${baseURL}/exchangeInfo`, {
      params: { symbol: normalizedSymbol },
      timeout: 15000,
    });

    const exchangeSymbol = (response.data.symbols as ExchangeInfoSymbol[] | undefined)?.[0];
    if (!exchangeSymbol) {
      throw new Error(`No exchange rules found for symbol ${normalizedSymbol}`);
    }

    const lotSizeFilter = exchangeSymbol.filters.find(
      (filter) => filter.filterType === 'LOT_SIZE'
    );
    const minNotionalFilter = exchangeSymbol.filters.find(
      (filter) =>
        filter.filterType === 'MIN_NOTIONAL' ||
        filter.filterType === 'NOTIONAL'
    );
    const priceFilter = exchangeSymbol.filters.find(
      (filter) => filter.filterType === 'PRICE_FILTER'
    );

    const rules: SymbolTradingRules = {
      symbol: exchangeSymbol.symbol,
      status: exchangeSymbol.status,
      baseAsset: exchangeSymbol.baseAsset,
      quoteAsset: exchangeSymbol.quoteAsset,
      minQty: Number(lotSizeFilter?.minQty ?? 0),
      maxQty: Number(lotSizeFilter?.maxQty ?? Number.MAX_SAFE_INTEGER),
      stepSize: Number(lotSizeFilter?.stepSize ?? 0),
      minNotional: Number(
        minNotionalFilter?.minNotional ?? minNotionalFilter?.notional ?? 0
      ),
      tickSize: Number(priceFilter?.tickSize ?? 0),
    };

    this.symbolRulesCache.set(normalizedSymbol, rules);
    return rules;
  }

  private async normalizeOrder(order: PreparedOrder): Promise<PreparedOrder> {
    const rules = await this.getSymbolTradingRules(order.symbol);

    if (rules.status !== 'TRADING') {
      throw new Error(`Symbol ${order.symbol} is not tradable. Exchange status: ${rules.status}`);
    }

    const normalizedQuantity = this.normalizeQuantity(order.quantity, rules);
    if (normalizedQuantity < rules.minQty) {
      throw new Error(
        `Order quantity ${normalizedQuantity} is below minQty ${rules.minQty} for ${order.symbol}`
      );
    }

    if (normalizedQuantity > rules.maxQty) {
      throw new Error(
        `Order quantity ${normalizedQuantity} exceeds maxQty ${rules.maxQty} for ${order.symbol}`
      );
    }

    const normalizedPrice =
      order.price !== undefined ? this.normalizePrice(order.price, rules) : undefined;
    const normalizedStopPrice =
      order.stopPrice !== undefined
        ? this.normalizePrice(order.stopPrice, rules)
        : undefined;
    const referencePrice = normalizedPrice ?? normalizedStopPrice;

    if (rules.minNotional > 0 && referencePrice !== undefined) {
      const notional = normalizedQuantity * referencePrice;
      if (notional < rules.minNotional) {
        throw new Error(
          `Order notional ${notional} is below minNotional ${rules.minNotional} for ${order.symbol}`
        );
      }
    }

    return {
      ...order,
      symbol: rules.symbol,
      quantity: normalizedQuantity,
      price: normalizedPrice,
      stopPrice: normalizedStopPrice,
    };
  }

  private normalizeQuantity(quantity: number, rules: SymbolTradingRules): number {
    const stepSize = rules.stepSize;
    if (!Number.isFinite(quantity) || quantity <= 0) {
      throw new Error(`Invalid order quantity ${quantity} for ${rules.symbol}`);
    }

    if (stepSize <= 0) {
      return quantity;
    }

    return this.floorToStep(quantity, stepSize);
  }

  private normalizePrice(price: number, rules: SymbolTradingRules): number {
    const tickSize = rules.tickSize;
    if (!Number.isFinite(price) || price <= 0) {
      throw new Error(`Invalid order price ${price} for ${rules.symbol}`);
    }

    if (tickSize <= 0) {
      return price;
    }

    return this.floorToStep(price, tickSize);
  }

  private floorToStep(value: number, step: number): number {
    const precision = this.getStepPrecision(step);
    const scaledValue = Math.floor(value / step) * step;
    return Number(scaledValue.toFixed(precision));
  }

  private getStepPrecision(step: number): number {
    if (!Number.isFinite(step) || step <= 0) {
      return 0;
    }

    const normalized = step.toString().toLowerCase();
    if (normalized.includes('e-')) {
      const exponent = normalized.split('e-')[1];
      return Number(exponent);
    }

    const decimalPart = normalized.split('.')[1];
    if (!decimalPart) {
      return 0;
    }

    return decimalPart.replace(/0+$/, '').length;
  }

  private async simulateOrderExecution(order: PreparedOrder): Promise<PreparedOrder> {
    // Simulate a brief delay for order processing
    await new Promise((resolve) => setTimeout(resolve, 100));

    if (order.status === 'CANCELLED') {
      return order;
    }

    return {
      ...order,
      status: 'FILLED',
      filledQuantity: order.quantity,
      averagePrice: order.price,
    };
  }

  private async placeBinanceOrder(order: PreparedOrder): Promise<PreparedOrder> {
    if (!this.config.apiKey || !this.config.apiSecret) {
      throw new Error('Missing Binance API credentials');
    }

    const recvWindow = this.config.recvWindow ?? 5000;
    const params = new URLSearchParams({
      symbol: order.symbol,
      side: order.side,
      type: this.mapOrderType(order.type),
      quantity: this.formatValue(order.quantity),
      recvWindow: String(recvWindow),
    });

    if (order.price !== undefined && order.type !== 'MARKET') {
      params.set('price', this.formatValue(order.price));
    }

    if (order.stopPrice !== undefined) {
      params.set('stopPrice', this.formatValue(order.stopPrice));
    }

    if (order.type !== 'MARKET' && order.type !== 'STOP_LOSS') {
      params.set('timeInForce', 'GTC');
    }

    const response = await OrderExecutor.sendSignedRequest<any>(
      this.config,
      'POST',
      '/order',
      params
    );
    const requestTimestamp = Number(response.config.params?.timestamp ?? Date.now());

    return {
      ...order,
      id: String(response.data.orderId ?? order.id),
      timestamp: Number(response.data.transactTime ?? requestTimestamp),
      status: this.mapBinanceOrderStatus(response.data.status),
      quantity: Number(response.data.origQty ?? order.quantity),
      filledQuantity: Number(response.data.executedQty ?? 0),
      averagePrice: this.extractAveragePrice(response.data, order),
    };
  }

  private mapOrderType(type: Order['type']): string {
    switch (type) {
      case 'MARKET':
        return 'MARKET';
      case 'LIMIT':
        return 'LIMIT';
      case 'STOP_LOSS':
        return 'STOP_LOSS';
      case 'TAKE_PROFIT':
        return 'TAKE_PROFIT';
      default:
        throw new Error(`Unsupported Binance order type ${type}`);
    }
  }

  private mapBinanceOrderStatus(status: string | undefined): Order['status'] {
    switch (status) {
      case 'NEW':
      case 'PARTIALLY_FILLED':
        return 'OPEN';
      case 'FILLED':
        return 'FILLED';
      case 'CANCELED':
      case 'EXPIRED':
      case 'REJECTED':
        return 'CANCELLED';
      default:
        return 'PENDING';
    }
  }

  private extractAveragePrice(responseData: any, order: PreparedOrder): number | undefined {
    const executedQty = Number(responseData.executedQty ?? 0);
    const cumulativeQuoteQty = Number(responseData.cummulativeQuoteQty ?? 0);

    if (executedQty > 0 && cumulativeQuoteQty > 0) {
      return cumulativeQuoteQty / executedQty;
    }

    const fills = responseData.fills as Array<{ price: string; qty: string }> | undefined;
    if (fills && fills.length > 0) {
      const totalQty = fills.reduce((sum, fill) => sum + Number(fill.qty), 0);
      const totalNotional = fills.reduce(
        (sum, fill) => sum + Number(fill.price) * Number(fill.qty),
        0
      );

      if (totalQty > 0) {
        return totalNotional / totalQty;
      }
    }

    return order.price;
  }

  private formatValue(value: number): string {
    return value.toFixed(16).replace(/\.?0+$/, '');
  }

  private generateOrderId(): string {
    return `ORDER_${Date.now()}_${++this.orderCounter}`;
  }

  private static getBaseURL(config: ExecutionConfig): string {
    if (config.baseURL) {
      return config.baseURL;
    }

    return config.testnet
      ? 'https://testnet.binance.vision/api/v3'
      : 'https://api.binance.com/api/v3';
  }

  private static async sendSignedRequest<T>(
    config: ExecutionConfig,
    method: 'GET' | 'POST',
    path: string,
    params: URLSearchParams | Record<string, string>,
    allowRetry: boolean = true
  ): Promise<AxiosResponse<T>> {
    const baseURL = OrderExecutor.getBaseURL(config);
    const paramsWithTimestamp =
      params instanceof URLSearchParams ? new URLSearchParams(params) : new URLSearchParams(params);

    paramsWithTimestamp.set(
      'timestamp',
      String(await OrderExecutor.getTimestamp(baseURL, config, false))
    );

    const signature = crypto
      .createHmac('sha256', config.apiSecret)
      .update(paramsWithTimestamp.toString())
      .digest('hex');
    paramsWithTimestamp.set('signature', signature);

    try {
      if (method === 'GET') {
        return await axios.get<T>(`${baseURL}${path}`, {
          headers: { 'X-MBX-APIKEY': config.apiKey },
          params: Object.fromEntries(paramsWithTimestamp.entries()),
          timeout: 15000,
        });
      }

      return await axios.post<T>(`${baseURL}${path}`, paramsWithTimestamp.toString(), {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'X-MBX-APIKEY': config.apiKey,
        },
        params: { timestamp: paramsWithTimestamp.get('timestamp') },
        timeout: 15000,
      });
    } catch (error) {
      const binanceError = OrderExecutor.getBinanceErrorPayload(error);
      if (allowRetry && binanceError?.code === -1021) {
        await OrderExecutor.getTimestamp(baseURL, config, true);
        return OrderExecutor.sendSignedRequest<T>(config, method, path, params, false);
      }

      throw error;
    }
  }

  private static async getTimestamp(
    baseURL: string,
    config: ExecutionConfig,
    forceRefresh: boolean
  ): Promise<number> {
    const now = Date.now();
    const cachedOffset = OrderExecutor.serverTimeOffsets.get(baseURL);
    if (
      !forceRefresh &&
      cachedOffset &&
      now - cachedOffset.syncedAt < OrderExecutor.serverTimeCacheTtlMs
    ) {
      return now + cachedOffset.offsetMs;
    }

    const response = await axios.get<{ serverTime: number }>(`${baseURL}/time`, {
      timeout: 15000,
    });
    const syncedAt = Date.now();
    const offsetMs = response.data.serverTime - syncedAt;

    OrderExecutor.serverTimeOffsets.set(baseURL, {
      offsetMs,
      syncedAt,
    });

    logger.info({ baseURL, offsetMs }, 'Synchronized Binance server time offset');

    return syncedAt + offsetMs;
  }

  private static getBinanceErrorPayload(error: unknown): BinanceErrorPayload | null {
    if (!axios.isAxiosError(error) || !error.response?.data) {
      return null;
    }

    const data = error.response.data as BinanceErrorPayload;
    if (typeof data !== 'object' || data === null) {
      return null;
    }

    return data;
  }
}
