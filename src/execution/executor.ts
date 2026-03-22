import axios from 'axios';
import crypto from 'crypto';
import logger from '../logger';
import type { Order, ExecutionConfig, AccountBalance, AccountInfo } from './types';

export class OrderExecutor {
  private config: ExecutionConfig;
  private orders: Map<string, Order> = new Map();
  private orderCounter: number = 0;

  constructor(config: ExecutionConfig) {
    this.config = config;
    logger.info(
      { testnet: config.testnet },
      'OrderExecutor initialized'
    );
  }

  async executeOrder(order: Omit<Order, 'id' | 'timestamp'>): Promise<Order> {
    const executedOrder: Order = {
      ...order,
      id: this.generateOrderId(),
      timestamp: Date.now(),
      status: order.status ?? 'PENDING',
    };

    this.orders.set(executedOrder.id as string, executedOrder);

    try {
      // Simulate order execution
      await this.simulateOrderExecution(executedOrder);

      logger.info(
        { orderId: executedOrder.id, symbol: order.symbol },
        'Order executed successfully'
      );

      return executedOrder;
    } catch (error) {
      executedOrder.status = 'FAILED';
      logger.error({ error, orderId: executedOrder.id }, 'Order execution failed');
      throw error;
    }
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

  getOpenOrders(): Order[] {
    return Array.from(this.orders.values()).filter(
      (order) => order.status === 'OPEN' || order.status === 'PENDING'
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

    const timestamp = Date.now();
    const recvWindow = 5000;
    const query = `timestamp=${timestamp}&recvWindow=${recvWindow}`;
    const signature = crypto
      .createHmac('sha256', config.apiSecret)
      .update(query)
      .digest('hex');

    const baseURL = OrderExecutor.getBaseURL(config);
    const url = `${baseURL}/account?${query}&signature=${signature}`;

    const response = await axios.get(url, {
      headers: { 'X-MBX-APIKEY': config.apiKey },
      timeout: 15000,
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

  private async simulateOrderExecution(order: Order): Promise<void> {
    // Simulate a brief delay for order processing
    await new Promise((resolve) => setTimeout(resolve, 100));

    if (order.status === 'CANCELLED') {
      return;
    }

    order.status = 'FILLED';
    order.filledQuantity = order.quantity;
    order.averagePrice = order.price;
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
}
