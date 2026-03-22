declare module 'sql.js' {
  export interface Database {
    run(sql: string): void;
    run(sql: string, params: any[]): void;
    exec(sql: string): any[];
    prepare(sql: string): Statement;
    export(): Uint8Array;
    close(): void;
  }

  export interface Statement {
    bind(params?: any[]): boolean;
    step(): boolean;
    getAsObject(): any;
    free(): boolean;
    reset(): void;
  }

  interface SqlJsStatic {
    Database: new (filebuffer?: ArrayLike<number>) => Database;
  }

  export default function initSqlJs(config?: any): Promise<SqlJsStatic>;
}
