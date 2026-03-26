import 'dotenv/config';
import axios from 'axios';
import { TrendPullbackStrategy, type StrategyConfig } from './strategy';
import type { CandleData } from './marketData';

const SYMBOL = (process.env.TRADING_SYMBOL || 'BTCUSDT').toUpperCase();
const ENTRY_SIGNAL_THRESHOLD = 0.05;
const MAX_POSITION_SIZE_PERCENT = 5;
const QUANTITY_PRECISION = 6;
const MAX_HOLD_TIME_MS = 15 * 60 * 1000;
const STOP_LOSS_ATR_MULTIPLE = 1;
const TAKE_PROFIT_ATR_MULTIPLE = 2.5;
const STARTING_BALANCE = 1000;
const WARMUP_MS = 60 * 60 * 1000 * 60;

type OpenPosition = {
  entryTime: number;
  entryPrice: number;
  quantity: number;
  entryAtr: number;
  reasoning: string;
  confidence: number;
};

type ClosedTrade = {
  entryTime: number;
  exitTime: number;
  entryPrice: number;
  exitPrice: number;
  quantity: number;
  pnl: number;
  pnlPercentOnPosition: number;
  exitReason: string;
  confidence: number;
};

function getDefaultStartTime(now: Date): Date {
  const start = new Date(now);
  start.setUTCDate(start.getUTCDate() - 1);
  start.setUTCHours(20, 0, 0, 0);
  return start;
}

async function fetchCandles(
  symbol: string,
  interval: '1m' | '15m',
  startTime: number,
  endTime: number
): Promise<CandleData[]> {
  const candles: CandleData[] = [];
  let cursor = startTime;

  while (cursor < endTime) {
    const response = await axios.get('https://api.binance.com/api/v3/klines', {
      params: {
        symbol,
        interval,
        startTime: cursor,
        endTime,
        limit: 1000,
      },
      timeout: 20000,
    });

    const batch = (response.data as any[]).map((candle) => ({
      timestamp: candle[0],
      open: Number(candle[1]),
      high: Number(candle[2]),
      low: Number(candle[3]),
      close: Number(candle[4]),
      volume: Number(candle[5]),
    })) as CandleData[];

    if (batch.length === 0) {
      break;
    }

    candles.push(...batch);
    cursor = batch[batch.length - 1].timestamp + 1;
  }

  return candles;
}

function calculateEMA(candles: CandleData[], period: number): number {
  if (candles.length < period) {
    return 0;
  }

  const smoothing = 2 / (period + 1);
  let ema =
    candles.slice(0, period).reduce((sum, candle) => sum + candle.close, 0) / period;

  for (let i = period; i < candles.length; i++) {
    ema = candles[i].close * smoothing + ema * (1 - smoothing);
  }

  return ema;
}

function calculateATR(candles: CandleData[], period: number): number {
  if (candles.length < period + 1) {
    return 0;
  }

  const trueRanges: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    const current = candles[i];
    const previous = candles[i - 1];
    trueRanges.push(
      Math.max(
        current.high - current.low,
        Math.abs(current.high - previous.close),
        Math.abs(current.low - previous.close)
      )
    );
  }

  const recentTrueRanges = trueRanges.slice(-period);
  return (
    recentTrueRanges.reduce((sum, value) => sum + value, 0) /
    recentTrueRanges.length
  );
}

function calculateOrderQuantity(accountBalance: number, price: number): number {
  const maxNotional = accountBalance * (MAX_POSITION_SIZE_PERCENT / 100);
  const rawQuantity = maxNotional / price;
  const factor = 10 ** QUANTITY_PRECISION;
  return Math.floor(rawQuantity * factor) / factor;
}

function formatDate(timestamp: number): string {
  return new Date(timestamp).toISOString();
}

async function main(): Promise<void> {
  const now = new Date();
  const requestedStart = process.env.BACKTEST_START
    ? new Date(process.env.BACKTEST_START)
    : getDefaultStartTime(now);

  if (Number.isNaN(requestedStart.getTime())) {
    throw new Error('Invalid BACKTEST_START value');
  }

  const endTime = now.getTime();
  const startTime = requestedStart.getTime();
  const warmupStartTime = startTime - WARMUP_MS;

  const [candles1m, candles15m] = await Promise.all([
    fetchCandles(SYMBOL, '1m', warmupStartTime, endTime),
    fetchCandles(SYMBOL, '15m', warmupStartTime, endTime),
  ]);

  if (candles1m.length === 0 || candles15m.length === 0) {
    throw new Error(`No candle data found for ${SYMBOL}`);
  }

  let accountBalance = STARTING_BALANCE;
  let openPosition: OpenPosition | null = null;
  const trades: ClosedTrade[] = [];

  const simCandles = candles1m.filter((candle) => candle.timestamp >= startTime);

  for (let i = 0; i < simCandles.length; i++) {
    const currentCandle = simCandles[i];
    const candlesUpToNow = candles1m.filter(
      (candle) => candle.timestamp <= currentCandle.timestamp
    );
    const higherTimeframeCandles = candles15m.filter(
      (candle) => candle.timestamp <= currentCandle.timestamp
    );

    const strategyConfig: StrategyConfig = {
      name: 'Trend Pullback Strategy',
      symbol: SYMBOL,
      enabled: true,
      parameters: {
        fastPeriod: 5,
        pullbackPeriod: 20,
        trendPeriod: 200,
        pullbackTolerancePercent: 0.15,
        higherTimeframeCandles,
      },
    };

    const strategy = new TrendPullbackStrategy(strategyConfig);
    strategy.updateCandles(candlesUpToNow.slice(-100));
    const signal = strategy.analyze();
    const atr = calculateATR(candlesUpToNow.slice(-100), 14);
    const currentPrice = currentCandle.close;

    if (openPosition) {
      const stopPrice = openPosition.entryPrice - openPosition.entryAtr * STOP_LOSS_ATR_MULTIPLE;
      const takeProfitPrice =
        openPosition.entryPrice + openPosition.entryAtr * TAKE_PROFIT_ATR_MULTIPLE;

      let exitReason: string | null = null;
      if (openPosition.entryAtr > 0 && currentPrice <= stopPrice) {
        exitReason = 'ATR stop loss';
      } else if (openPosition.entryAtr > 0 && currentPrice >= takeProfitPrice) {
        exitReason = 'ATR take profit';
      } else if (signal.action === 'SELL') {
        exitReason = 'Strategy exit signal';
      } else if (currentCandle.timestamp - openPosition.entryTime >= MAX_HOLD_TIME_MS) {
        exitReason = 'Max hold time reached';
      }

      if (exitReason) {
        const pnl = (currentPrice - openPosition.entryPrice) * openPosition.quantity;
        accountBalance += pnl;
        trades.push({
          entryTime: openPosition.entryTime,
          exitTime: currentCandle.timestamp,
          entryPrice: openPosition.entryPrice,
          exitPrice: currentPrice,
          quantity: openPosition.quantity,
          pnl,
          pnlPercentOnPosition:
            ((currentPrice - openPosition.entryPrice) / openPosition.entryPrice) * 100,
          exitReason,
          confidence: openPosition.confidence,
        });
        openPosition = null;
      }
    }

    if (!openPosition && signal.action === 'BUY' && signal.confidence >= ENTRY_SIGNAL_THRESHOLD) {
      const quantity = calculateOrderQuantity(accountBalance, currentPrice);
      if (quantity > 0) {
        openPosition = {
          entryTime: currentCandle.timestamp,
          entryPrice: currentPrice,
          quantity,
          entryAtr: atr,
          reasoning: signal.reasoning,
          confidence: signal.confidence,
        };
      }
    }
  }

  const lastPrice = simCandles[simCandles.length - 1]?.close ?? candles1m[candles1m.length - 1].close;
  const unrealizedPnL = openPosition
    ? (lastPrice - openPosition.entryPrice) * openPosition.quantity
    : 0;
  const totalEquity = accountBalance + unrealizedPnL;
  const realizedPnL = trades.reduce((sum, trade) => sum + trade.pnl, 0);
  const winCount = trades.filter((trade) => trade.pnl > 0).length;
  const lossCount = trades.filter((trade) => trade.pnl < 0).length;
  const trendEndEma = calculateEMA(candles15m, 200);

  console.log(
    JSON.stringify(
      {
        symbol: SYMBOL,
        assumedStartingBalance: STARTING_BALANCE,
        assumedStartTime: formatDate(startTime),
        endTime: formatDate(endTime),
        lastPrice,
        realizedPnL,
        realizedReturnPercent: (realizedPnL / STARTING_BALANCE) * 100,
        unrealizedPnL,
        totalPnL: totalEquity - STARTING_BALANCE,
        totalReturnPercent: ((totalEquity - STARTING_BALANCE) / STARTING_BALANCE) * 100,
        closedTrades: trades.length,
        wins: winCount,
        losses: lossCount,
        finalAccountBalanceExOpenPnL: accountBalance,
        finalEquity: totalEquity,
        openPosition: openPosition
          ? {
              entryTime: formatDate(openPosition.entryTime),
              entryPrice: openPosition.entryPrice,
              quantity: openPosition.quantity,
              entryAtr: openPosition.entryAtr,
              markPrice: lastPrice,
              unrealizedPnL,
              reasoning: openPosition.reasoning,
              confidence: openPosition.confidence,
            }
          : null,
        trades: trades.map((trade) => ({
          ...trade,
          entryTime: formatDate(trade.entryTime),
          exitTime: formatDate(trade.exitTime),
        })),
        endTrendEma200On15m: trendEndEma,
      },
      null,
      2
    )
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
