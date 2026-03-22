import 'dotenv/config';
import logger from './logger';
import { BinanceWebSocket, getPriceDatabase, PriceDatabase } from './marketData';

/**
 * Example: Real-time BTCUSDT price streaming from Binance WebSocket
 * With automatic reconnection handling and SQLite database storage
 */
async function main(): Promise<void> {
  const ws = new BinanceWebSocket({
    reconnectInterval: 3000, // 3 seconds between reconnect attempts
    maxReconnectAttempts: 10,
    heartbeatInterval: 30000, // 30 seconds heartbeat
  });

  let db: PriceDatabase;
  try {
    db = await getPriceDatabase('./prices.db');
  } catch (error) {
    logger.error({ error }, 'Failed to initialize database');
    process.exit(1);
  }

  // Event: Connected
  ws.on('connected', () => {
    logger.info('✓ WebSocket connected successfully');
  });

  // Event: Disconnected
  ws.on('disconnected', () => {
    logger.warn('✗ WebSocket disconnected');
  });

  // Event: Price update (main data stream)
  ws.on('price', (update) => {
    // Prices are already logged in websocket.ts, but you can add custom handling here
    logger.debug({ symbol: update.symbol, price: update.price }, 'Price received');
    
    // Save price to database
    try {
      db.savePrice(update.timestamp, update.symbol, update.price);
      logger.debug({ symbol: update.symbol }, 'Price stored in database');
    } catch (error) {
      logger.error({ error }, 'Failed to save price to database');
    }
  });

  // Event: Errors
  ws.on('error', (error) => {
    logger.error({ error }, '⚠ WebSocket error occurred');
  });

  // Event: Max reconnect attempts reached
  ws.on('max_reconnect_attempts_reached', () => {
    logger.error('✗ Failed to reconnect after maximum attempts');
    db.close();
    process.exit(1);
  });

  try {
    logger.info('Starting BTCUSDT live price stream...');
    logger.info('Storing prices in SQLite database: prices.db');
    logger.info('Press Ctrl+C to stop\n');

    // Connect and stream BTCUSDT
    ws.connect(['BTCUSDT']);

    // Handle graceful shutdown
    process.on('SIGINT', () => {
      logger.info('\nShutting down gracefully...');
      
      // Display statistics before closing
      try {
        const stats = db.getStatistics('BTCUSDT');
        if (stats) {
          logger.info(
            {
              count: stats.count,
              minPrice: stats.minPrice.toFixed(2),
              maxPrice: stats.maxPrice.toFixed(2),
              avgPrice: stats.avgPrice.toFixed(2),
            },
            'BTCUSDT Statistics'
          );
        }

        const allSymbols = db.getAllSymbols();
        logger.info({ symbols: allSymbols }, 'Stored symbols in database');
      } catch (error) {
        logger.error({ error }, 'Failed to fetch statistics');
      }

      ws.disconnect();
      db.close();
      logger.info('Disconnected from WebSocket and database');
      process.exit(0);
    });

    // Optionally subscribe to additional symbols after connection
    setTimeout(() => {
      if (ws.isConnected()) {
        logger.info('Subscribing to ETHUSDT...');
        ws.subscribe(['ETHUSDT']);
      }
    }, 5000);
  } catch (error) {
    logger.error({ error }, 'Fatal error in main');
    db.close();
    process.exit(1);
  }
}

main();
