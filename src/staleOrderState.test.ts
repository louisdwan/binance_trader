import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import axios from 'axios';
import { TradingSystem } from './index';
import { OrderExecutor, type ExecutionConfig } from './execution';
import { FileStateStore, type PersistedTradingState } from './runtime/stateStore';
import { RiskManager } from './risk/manager';
import type { RiskConfig } from './risk';

const baseExecutionConfig: ExecutionConfig = {
  apiKey: 'test-key',
  apiSecret: 'test-secret',
  dryRun: true,
  testnet: true,
};

const baseRiskConfig: RiskConfig = {
  maxPositionSize: 5,
  maxDrawdownPercent: 10,
  stopLossPercent: 1,
  takeProfitPercent: 2.5,
  dailyLossLimit: 500,
  maxRiskPerTradePercent: 1,
  maxDailyLossPercent: 2,
};

function buildTicker(symbol: string, price: number) {
  return {
    symbol,
    price,
    bid: price,
    ask: price,
  };
}

async function createSystem(symbols: string[] = ['BTCEUR']) {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'binance-trader-test-'));
  const stateStore = new FileStateStore(path.join(tempDir, 'bot-state.json'));
  const marketDataProvider = {
    async getTicker(symbol: string) {
      return buildTicker(symbol, symbol === 'ETHEUR' ? 2000 : 52000);
    },
    async getCandles() {
      return [];
    },
  };

  const system = new TradingSystem(
    marketDataProvider as never,
    baseExecutionConfig,
    baseRiskConfig,
    1000,
    symbols,
    {
      quoteAsset: 'EUR',
      baseAssets: Object.fromEntries(
        symbols.map((symbol) => [symbol, symbol === 'ETHEUR' ? 'ETH' : 'BTC'])
      ) as Record<string, string>,
      stateStore,
      strategyTemplates: [],
    }
  );

  const executor = system.getOrderExecutor() as OrderExecutor & {
    getAccountInfo: () => Promise<unknown>;
    getSymbolTradingRules: (symbol: string) => Promise<unknown>;
  };

  executor.getAccountInfo = async () => ({
    canTrade: true,
    canWithdraw: true,
    canDeposit: true,
    updateTime: Date.now(),
    balances: [
      { asset: 'EUR', free: 1000, locked: 0 },
      { asset: 'BTC', free: 0, locked: 0 },
      { asset: 'ETH', free: 0, locked: 0 },
    ],
  });
  executor.getSymbolTradingRules = async (symbol: string) => ({
    symbol,
    status: 'TRADING',
    baseAsset: symbol === 'ETHEUR' ? 'ETH' : 'BTC',
    quoteAsset: 'EUR',
    minQty: 0.00001,
    maxQty: 1000,
    stepSize: 0.00001,
    minNotional: 10,
    tickSize: 0.01,
  });

  return { system, tempDir };
}

test('market orders resolve to FILLED when exchange fills are present even if status is missing', async () => {
  const originalGet = axios.get;
  const originalPost = axios.post;

  axios.get = (async (url: string) => {
    if (url.endsWith('/exchangeInfo')) {
      return {
        data: {
          symbols: [
            {
              symbol: 'BTCEUR',
              status: 'TRADING',
              baseAsset: 'BTC',
              quoteAsset: 'EUR',
              filters: [
                { filterType: 'LOT_SIZE', minQty: '0.00001', maxQty: '1000', stepSize: '0.00001' },
                { filterType: 'MIN_NOTIONAL', minNotional: '10' },
                { filterType: 'PRICE_FILTER', tickSize: '0.01' },
              ],
            },
          ],
        },
      } as never;
    }

    if (url.endsWith('/time')) {
      return { data: { serverTime: Date.now() } } as never;
    }

    throw new Error(`Unexpected axios.get call: ${url}`);
  }) as typeof axios.get;

  axios.post = (async () => ({
    data: {
      orderId: 'BINANCE_ORDER_1',
      transactTime: Date.now(),
      origQty: '0.001',
      executedQty: '0.001',
      cummulativeQuoteQty: '60',
      fills: [{ price: '60000', qty: '0.001' }],
    },
    config: {},
  })) as typeof axios.post;

  try {
    const executor = new OrderExecutor({
      apiKey: 'test-key',
      apiSecret: 'test-secret',
      dryRun: false,
      testnet: true,
      baseURL: 'https://example.test/api/v3',
    });

    const order = await executor.executeOrder({
      symbol: 'BTCEUR',
      side: 'BUY',
      type: 'MARKET',
      quantity: 0.001,
      price: 60000,
      status: 'PENDING',
    });

    assert.equal(order.status, 'FILLED');
    assert.equal(order.filledQuantity, 0.001);
  } finally {
    axios.get = originalGet;
    axios.post = originalPost;
  }
});

test('restart normalizes stale persisted pending market buy orders backed by journal/open position', async () => {
  const { system, tempDir } = await createSystem();
  const executor = system.getOrderExecutor();
  const oldTimestamp = Date.now() - 8 * 24 * 60 * 60 * 1000;

  (executor as OrderExecutor & { getAccountInfo: () => Promise<unknown> }).getAccountInfo = async () => ({
    canTrade: true,
    canWithdraw: true,
    canDeposit: true,
    updateTime: Date.now(),
    balances: [
      { asset: 'EUR', free: 1000, locked: 0 },
      { asset: 'BTC', free: 0.01, locked: 0 },
    ],
  });

  const state: PersistedTradingState = {
    version: 2,
    savedAt: Date.now(),
    symbols: ['BTCEUR'],
    runtime: {
      state: 'idle',
      cycleIntervalMs: 60000,
      lastCycleStartedAt: null,
      lastCycleCompletedAt: null,
      lastCycleError: null,
    },
    openTrades: [
      {
        symbol: 'BTCEUR',
        tradeId: 'ORDER_BUY_1',
        entryAtr: 100,
      },
    ],
    risk: {
      positions: [
        {
          symbol: 'BTCEUR',
          quantity: 0.01,
          entryPrice: 50000,
          currentPrice: 52000,
          unrealizedPnL: 20,
          unrealizedPnLPercent: 4,
        },
      ],
      accountBalance: 1000,
      realizedPnL: 0,
      dailyRealizedPnL: 0,
      peakEquity: 1020,
      currentDay: new Date().toISOString().slice(0, 10),
    },
    journal: [
      {
        id: 'ORDER_BUY_1',
        symbol: 'BTCEUR',
        entryTime: oldTimestamp,
        entryPrice: 50000,
        quantity: 0.01,
        side: 'BUY',
        strategyName: 'Test Strategy',
      },
    ],
    orders: [
      {
        id: 'ORDER_BUY_1',
        symbol: 'BTCEUR',
        side: 'BUY',
        type: 'MARKET',
        quantity: 0.01,
        price: 50000,
        status: 'PENDING',
        timestamp: oldTimestamp,
      },
    ],
  };

  try {
    await system.restoreFromState(state);
    const status = system.getOperatorStatus();

    assert.equal(executor.getOrder('ORDER_BUY_1')?.status, 'FILLED');
    assert.equal(status.openOrderVisibility.totalOpenOrders, 0);
    assert.equal(status.reconciliation.orders.cumulativeReclassifiedFilled, 1);
    assert.equal(status.reconciliation.orders.reclassifiedFailed, 0);
    assert.equal(status.failures.lastError, null);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('exchange reconciliation clears stale local pending market sell artifacts safely', async () => {
  const { system, tempDir } = await createSystem();
  const executor = system.getOrderExecutor();
  const oldTimestamp = Date.now() - 8 * 24 * 60 * 60 * 1000;

  try {
    await system.restoreFromState(null);

    executor.restoreOrders([
      {
        id: 'ORDER_SELL_1',
        symbol: 'BTCEUR',
        side: 'SELL',
        type: 'MARKET',
        quantity: 0.01,
        price: 50000,
        status: 'PENDING',
        timestamp: oldTimestamp,
      },
    ]);

    await (system as any).reconcileWithExchange();

    const status = system.getOperatorStatus();
    assert.equal(executor.getOrder('ORDER_SELL_1')?.status, 'FAILED');
    assert.equal(status.reconciliation.orders.cumulativeReclassifiedFailed, 1);
    assert.equal(status.openOrderVisibility.totalOpenOrders, 0);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('operator status shows stale pending orders before normalization and clears them after cleanup', async () => {
  const { system, tempDir } = await createSystem();
  const executor = system.getOrderExecutor();
  const oldTimestamp = Date.now() - 8 * 24 * 60 * 60 * 1000;

  try {
    executor.restoreOrders([
      {
        id: 'ORDER_STALE_1',
        symbol: 'BTCEUR',
        side: 'BUY',
        type: 'MARKET',
        quantity: 0.01,
        price: 50000,
        status: 'PENDING',
        timestamp: oldTimestamp,
      },
    ]);

    const before = system.getOperatorStatus();
    assert.equal(before.openOrderVisibility.totalOpenOrders, 1);
    assert.equal(before.operatorState.reasonCode, 'stale-open-orders');
    assert.equal(before.severity, 'warning');

    (system as any).normalizeLocalOrderState('test cleanup');

    const after = system.getOperatorStatus();
    assert.equal(after.openOrderVisibility.totalOpenOrders, 0);
    assert.equal(after.operatorState.reasonCode, 'awaiting-next-cycle');
    assert.equal(after.severity, 'ok');
    assert.equal(after.reconciliation.orders.cumulativeReclassifiedFailed, 1);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('closePosition sizes exit orders to exchange-available balance', async () => {
  const { system, tempDir } = await createSystem();
  const executor = system.getOrderExecutor() as OrderExecutor & {
    getAssetBalance: (asset: string) => Promise<unknown>;
    normalizeSymbolQuantity: (symbol: string, quantity: number) => Promise<number>;
    executeOrder: (order: Record<string, unknown>) => Promise<any>;
  };
  const riskManager = system.getRiskManager();
  const now = Date.now();

  riskManager.openPosition('BTCEUR', 0.0008, 58463.73);
  system.getJournal().recordEntry({
    id: 'ORDER_BUY_ACTIVE',
    symbol: 'BTCEUR',
    entryTime: now - 60_000,
    entryPrice: 58463.73,
    quantity: 0.0008,
    side: 'BUY',
    strategyName: 'Test Strategy',
  });
  (system as any).openTrades.set('BTCEUR', {
    tradeId: 'ORDER_BUY_ACTIVE',
    entryAtr: 20,
  });

  let submittedQuantity = 0;
  executor.getAssetBalance = async () => ({ asset: 'BTC', free: 0.00061, locked: 0 });
  executor.normalizeSymbolQuantity = async (_symbol: string, quantity: number) => quantity;
  (executor.executeOrder as any) = async (order: Record<string, unknown>) => {
    submittedQuantity = Number(order.quantity);
    return {
      ...order,
      id: 'ORDER_SELL_ACTIVE',
      timestamp: now,
      status: 'FILLED',
      quantity: Number(order.quantity),
      filledQuantity: Number(order.quantity),
      averagePrice: 58800,
    };
  };

  try {
    await (system as any).closePosition('BTCEUR', 58800, 'test exit');

    assert.equal(submittedQuantity, 0.00061);
    assert.equal(system.getRiskManager().getPosition('BTCEUR'), undefined);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('paused critical state does not recommend resume while open-position failure remains', async () => {
  const { system, tempDir } = await createSystem();
  const riskManager = system.getRiskManager();

  try {
    riskManager.openPosition('BTCEUR', 0.001, 50000);
    (system as any).state = 'paused';
    (system as any).pauseReason = 'Manual operator pause';
    (system as any).lastCycleError = 'Request failed with status code 400';

    const status = system.getOperatorStatus();
    assert.equal(status.severity, 'critical');
    assert.equal(status.recommendedAction, 'close-position');
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('reconciliation keeps effective account balance aligned with quote cash plus position cost basis', async () => {
  const { system, tempDir } = await createSystem();
  const executor = system.getOrderExecutor() as OrderExecutor & {
    getAccountInfo: () => Promise<unknown>;
  };
  const oldTimestamp = Date.now() - 60_000;

  const state: PersistedTradingState = {
    version: 2,
    savedAt: Date.now(),
    symbols: ['BTCEUR'],
    runtime: {
      state: 'idle',
      cycleIntervalMs: 60000,
      lastCycleStartedAt: null,
      lastCycleCompletedAt: null,
      lastCycleError: null,
    },
    openTrades: [
      {
        symbol: 'BTCEUR',
        tradeId: 'ORDER_BUY_BALANCE',
        entryAtr: 50,
      },
    ],
    risk: {
      positions: [
        {
          symbol: 'BTCEUR',
          quantity: 0.001,
          entryPrice: 100000,
          currentPrice: 100000,
          unrealizedPnL: 0,
          unrealizedPnLPercent: 0,
        },
      ],
      accountBalance: 1000,
      realizedPnL: 0,
      dailyRealizedPnL: 0,
      peakEquity: 1000,
      currentDay: new Date().toISOString().slice(0, 10),
    },
    journal: [
      {
        id: 'ORDER_BUY_BALANCE',
        symbol: 'BTCEUR',
        entryTime: oldTimestamp,
        entryPrice: 100000,
        quantity: 0.001,
        side: 'BUY',
        strategyName: 'Test Strategy',
      },
    ],
    orders: [],
  };

  executor.getAccountInfo = async () => ({
    canTrade: true,
    canWithdraw: true,
    canDeposit: true,
    updateTime: Date.now(),
    balances: [
      { asset: 'EUR', free: 900, locked: 0 },
      { asset: 'BTC', free: 0.001, locked: 0 },
    ],
  });

  try {
    await system.restoreFromState(state);

    assert.equal(system.getRiskManager().getAccountBalance(), 1000);
    assert.equal(system.getStatus().riskMetrics.totalExposure, 52);
    assert.equal(system.getStatus().riskMetrics.unrealizedPnL, -48);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('external cash transfer with no open positions shifts drawdown baseline instead of triggering fake drawdown', () => {
  const riskManager = new RiskManager(baseRiskConfig, 1000);

  riskManager.setAccountBalance(600, {
    treatAsExternalCashFlow: true,
    reason: 'transfer to futures wallet',
  });

  const metrics = riskManager.getRiskMetrics();
  assert.equal(riskManager.getAccountBalance(), 600);
  assert.equal(metrics.drawdownPercent, 0);
  assert.equal(metrics.drawdown, 0);
});
