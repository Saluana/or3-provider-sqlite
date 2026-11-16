import { randomUUID } from 'node:crypto';
import { type Kysely, sql, CompiledQuery } from 'kysely';
import { isD1Driver } from '../kysely';
import { ensureMigrationSchema } from '../migration-schema';
import { historyBatch, readHistoryIncarnation } from '../../sync/history-incarnation';
export async function up(db: Kysely<unknown>): Promise<void> {
    await ensureMigrationSchema(db, 'CREATE TABLE sync_history (id INTEGER PRIMARY KEY CHECK(id = 1), incarnation TEXT NOT NULL)');
    // D1 can interrupt after DDL; initialization + invalidation commit atomically.
    // A retry after that commit preserves the singleton and new bound state.
    const statements = [
        { sql: 'DELETE FROM sync_snapshot_items WHERE NOT EXISTS (SELECT 1 FROM sync_history)'},
        { sql: 'DELETE FROM sync_snapshots WHERE NOT EXISTS (SELECT 1 FROM sync_history)'},
        { sql: 'DELETE FROM device_cursors WHERE NOT EXISTS (SELECT 1 FROM sync_history)'},
        { sql: 'INSERT INTO sync_history (id,incarnation) SELECT 1,? WHERE NOT EXISTS (SELECT 1 FROM sync_history)',parameters: [randomUUID()] },
    ];
    if (isD1Driver()) await historyBatch(statements);
    else {
        const initialize = async (transaction: Kysely<unknown>) => {
            for (const statement of statements) {
                await transaction.executeQuery(CompiledQuery.raw(statement.sql, statement.parameters ?? []));
            }
        };
        if (db.isTransaction) await initialize(db);
        else await db.transaction().execute(initialize);
    }
    await readHistoryIncarnation();
}
export async function down(db: Kysely<unknown>): Promise<void> {
    await sql`DROP TABLE sync_history`.execute(db);
}
