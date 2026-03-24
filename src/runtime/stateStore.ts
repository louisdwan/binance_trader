import fs from 'fs/promises';
import path from 'path';
import logger from '../logger';
import type { Order } from '../execution/types';
import type { TradeEntry } from '../journal/types';
import type { RiskManagerState } from '../risk/types';

export type PersistedOpenTrade = {
  symbol: string;
  tradeId: string;
  entryAtr: number;
};

export type PersistedRuntimeState = {
  state: 'idle' | 'paused';
  cycleIntervalMs: number | null;
  lastCycleStartedAt: number | null;
  lastCycleCompletedAt: number | null;
  lastCycleError: string | null;
};

export type PersistedTradingState = {
  version: 1;
  savedAt: number;
  symbol: string;
  runtime: PersistedRuntimeState;
  openTrades: PersistedOpenTrade[];
  risk: RiskManagerState;
  journal: TradeEntry[];
  orders: Order[];
};

export class FileStateStore {
  private readonly filePath: string;

  constructor(filePath: string) {
    this.filePath = filePath;
  }

  async load(): Promise<PersistedTradingState | null> {
    try {
      const raw = await fs.readFile(this.filePath, 'utf8');
      return JSON.parse(raw) as PersistedTradingState;
    } catch (error: unknown) {
      if (this.isMissingFileError(error)) {
        return null;
      }

      logger.error({ error, filePath: this.filePath }, 'Failed to load persisted bot state');
      throw error;
    }
  }

  async save(state: PersistedTradingState): Promise<void> {
    const directory = path.dirname(this.filePath);
    const tempFilePath = `${this.filePath}.tmp`;

    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(tempFilePath, JSON.stringify(state, null, 2), 'utf8');
    await fs.rename(tempFilePath, this.filePath);
  }

  getFilePath(): string {
    return this.filePath;
  }

  private isMissingFileError(error: unknown): boolean {
    return (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      (error as NodeJS.ErrnoException).code === 'ENOENT'
    );
  }
}
