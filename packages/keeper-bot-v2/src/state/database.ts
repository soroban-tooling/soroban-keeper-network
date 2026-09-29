/**
 * Database Connection Management
 *
 * Provides a singleton-like pattern for database access with proper
 * initialization and cleanup.
 */

import Database from 'better-sqlite3';
import { initializeSchema } from './schema.js';

let instance: Database.Database | null = null;

/**
 * Get the database instance, initializing if needed.
 *
 * @param dbPath - Path to the SQLite database file
 * @returns The database instance
 */
export function getDatabase(dbPath: string): Database.Database {
  if (!instance) {
    instance = initializeSchema(dbPath);
  }
  return instance;
}

/**
 * Close the database connection.
 *
 * This should be called during graceful shutdown to ensure
 * all pending writes are flushed and resources are cleaned up.
 */
export function closeDatabase(): void {
  if (instance) {
    instance.close();
    instance = null;
  }
}

/**
 * Check if the database is currently open.
 *
 * @returns true if the database instance is initialized
 */
export function isDatabaseOpen(): boolean {
  return instance !== null;
}

/**
 * Re-initialize the database (useful for testing).
 *
 * @param dbPath - Path to the SQLite database file
 * @returns The new database instance
 */
export function reinitializeDatabase(dbPath: string): Database.Database {
  closeDatabase();
  instance = initializeSchema(dbPath);
  return instance;
}
