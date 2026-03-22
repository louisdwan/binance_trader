import initSqlJs, { Database as SqlJsDatabase } from 'sql.js';
import { writeFileSync, readFileSync, existsSync } from 'fs';
import logger from '../logger';

export interface PriceRecord {
  id?: number;
  timestamp: number;
  symbol: string;
  price: number;
}

export class PriceDatabase {
  private db: SqlJsDatabase | null = null;
  private dbPath: string;
  private initialized: boolean = false;

  constructor(dbPath: string = './prices.db') {
    this.dbPath = dbPath;
  }

  async initialize(): Promise<void> {
    try {
      const SQL = await initSqlJs();

      // Load existing database or create new one
      if (existsSync(this.dbPath)) {
        const data = readFileSync(this.dbPath);
        this.db = new SQL.Database(data);
        logger.info({ dbPath: this.dbPath }, 'Loaded existing SQLite database');
      } else {
        this.db = new SQL.Database();
        logger.info({ dbPath: this.dbPath }, 'Created new SQLite database');
      }

      this.initializeSchema();
      this.initialized = true;
      logger.info('Database initialized successfully');
    } catch (error) {
      logger.error({ error }, 'Failed to initialize database');
      throw error;
    }
  }

  private initializeSchema(): void {
    if (!this.db) {
      throw new Error('Database not initialized');
    }

    try {
      this.db.run(`
        CREATE TABLE IF NOT EXISTS prices (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          timestamp INTEGER NOT NULL,
          symbol TEXT NOT NULL,
          price REAL NOT NULL,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );
      `);

      // Create indexes
      this.db.run(`
        CREATE INDEX IF NOT EXISTS idx_prices_symbol_timestamp 
        ON prices(symbol, timestamp DESC);
      `);

      this.db.run(`
        CREATE INDEX IF NOT EXISTS idx_prices_timestamp 
        ON prices(timestamp DESC);
      `);

      this.save();
      logger.info('Database schema initialized');
    } catch (error) {
      logger.error({ error }, 'Failed to initialize database schema');
      throw error;
    }
  }

  savePrice(timestamp: number, symbol: string, price: number): PriceRecord {
    if (!this.db || !this.initialized) {
      throw new Error('Database not initialized');
    }

    try {
      this.db.run(
        'INSERT INTO prices (timestamp, symbol, price) VALUES (?, ?, ?)',
        [timestamp, symbol, price]
      );

      this.save();

      logger.debug(
        { symbol, price, timestamp },
        'Price saved to database'
      );

      return {
        timestamp,
        symbol,
        price,
      };
    } catch (error) {
      logger.error(
        { error, symbol, price, timestamp },
        'Failed to save price'
      );
      throw error;
    }
  }

  getPricesBySymbol(symbol: string, limit: number = 100): PriceRecord[] {
    if (!this.db) {
      throw new Error('Database not initialized');
    }

    try {
      const stmt = this.db.prepare(
        'SELECT id, timestamp, symbol, price FROM prices WHERE symbol = ? ORDER BY timestamp DESC LIMIT ?'
      );
      stmt.bind([symbol, limit]);

      const rows: PriceRecord[] = [];
      while (stmt.step()) {
        const row = stmt.getAsObject() as PriceRecord;
        rows.push(row);
      }
      stmt.free();

      return rows;
    } catch (error) {
      logger.error({ error, symbol }, 'Failed to fetch prices by symbol');
      throw error;
    }
  }

  getPricesByTimeRange(
    symbol: string,
    startTime: number,
    endTime: number
  ): PriceRecord[] {
    if (!this.db) {
      throw new Error('Database not initialized');
    }

    try {
      const stmt = this.db.prepare(
        'SELECT id, timestamp, symbol, price FROM prices WHERE symbol = ? AND timestamp BETWEEN ? AND ? ORDER BY timestamp DESC'
      );
      stmt.bind([symbol, startTime, endTime]);

      const rows: PriceRecord[] = [];
      while (stmt.step()) {
        const row = stmt.getAsObject() as PriceRecord;
        rows.push(row);
      }
      stmt.free();

      return rows;
    } catch (error) {
      logger.error(
        { error, symbol, startTime, endTime },
        'Failed to fetch prices by time range'
      );
      throw error;
    }
  }

  getAllSymbols(): string[] {
    if (!this.db) {
      throw new Error('Database not initialized');
    }

    try {
      const stmt = this.db.prepare(
        'SELECT DISTINCT symbol FROM prices ORDER BY symbol'
      );

      const symbols: string[] = [];
      while (stmt.step()) {
        const row = stmt.getAsObject() as { symbol: string };
        symbols.push(row.symbol);
      }
      stmt.free();

      return symbols;
    } catch (error) {
      logger.error({ error }, 'Failed to fetch all symbols');
      throw error;
    }
  }

  getLatestPrice(symbol: string): PriceRecord | null {
    if (!this.db) {
      throw new Error('Database not initialized');
    }

    try {
      const stmt = this.db.prepare(
        'SELECT id, timestamp, symbol, price FROM prices WHERE symbol = ? ORDER BY timestamp DESC LIMIT 1'
      );
      stmt.bind([symbol]);

      let row: PriceRecord | null = null;
      if (stmt.step()) {
        row = stmt.getAsObject() as PriceRecord;
      }
      stmt.free();

      return row;
    } catch (error) {
      logger.error({ error, symbol }, 'Failed to fetch latest price');
      throw error;
    }
  }

  getStatistics(symbol: string): {
    count: number;
    minPrice: number;
    maxPrice: number;
    avgPrice: number;
  } | null {
    if (!this.db) {
      throw new Error('Database not initialized');
    }

    try {
      const stmt = this.db.prepare(
        'SELECT COUNT(*) as count, MIN(price) as minPrice, MAX(price) as maxPrice, AVG(price) as avgPrice FROM prices WHERE symbol = ?'
      );
      stmt.bind([symbol]);

      let stats = null;
      if (stmt.step()) {
        const row = stmt.getAsObject() as any;
        if (row.count > 0) {
          stats = {
            count: row.count,
            minPrice: row.minPrice,
            maxPrice: row.maxPrice,
            avgPrice: row.avgPrice,
          };
        }
      }
      stmt.free();

      return stats;
    } catch (error) {
      logger.error({ error, symbol }, 'Failed to fetch statistics');
      throw error;
    }
  }

  deleteOldPrices(hoursToKeep: number = 24): number {
    if (!this.db) {
      throw new Error('Database not initialized');
    }

    try {
      const cutoffTime = Date.now() - hoursToKeep * 60 * 60 * 1000;
      this.db.run('DELETE FROM prices WHERE timestamp < ?', [cutoffTime]);
      this.save();

      logger.info(
        { hoursToKeep },
        'Old prices deleted'
      );

      return 0;
    } catch (error) {
      logger.error(
        { error, hoursToKeep },
        'Failed to delete old prices'
      );
      throw error;
    }
  }

  private save(): void {
    if (!this.db) {
      return;
    }

    try {
      const data = this.db.export();
      const buffer = Buffer.from(data);
      writeFileSync(this.dbPath, buffer);
    } catch (error) {
      logger.warn({ error }, 'Failed to save database to disk');
    }
  }

  close(): void {
    try {
      if (this.db) {
        this.save();
        this.db.close();
      }
      logger.info('Database connection closed');
    } catch (error) {
      logger.error({ error }, 'Failed to close database');
    }
  }
}

let instance: PriceDatabase | null = null;

export async function getPriceDatabase(dbPath?: string): Promise<PriceDatabase> {
  if (!instance) {
    instance = new PriceDatabase(dbPath);
    await instance.initialize();
  }
  return instance;
}
