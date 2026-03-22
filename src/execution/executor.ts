import logger from '../logger';
import type { Order, OrderStatus, ExecutionConfig } from './types';

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
      status: 'PENDING',
    };

    this.orders.set(executedOrder.id, executedOrder);

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
      (order) => order.status === 'OPEN'
    );
  }

  private async simulateOrderExecution(order: Order): Promise<void> {
    // Simulate a brief delay for order processing
    await new Promise((resolve) => setTimeout(resolve, 100));

    order.status = 'FILLED';
    order.filledQuantity = order.quantity;
    order.averagePrice = order.price || 0;
  }

  private generateOrderId(): string {
    return `ORDER_${Date.now()}_${++this.orderCounter}`;
  }
}
