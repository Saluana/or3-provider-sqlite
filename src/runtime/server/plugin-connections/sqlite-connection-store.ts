import type {
    ConnectionTestEvidence,
    PluginConnectionUpdate,
    StoredPluginConnection,
} from '~~/shared/plugins/connections/contracts';
import type { PluginConnectionStore } from '~~/server/utils/plugins/connections/store/registry';
import {
    getRawDb,
    getSqliteDriver,
    type SqliteRawDatabase,
} from '../db/kysely';

type SqliteDatabase = SqliteRawDatabase;

type ConnectionRow = {
    id: string;
    owner_user_id: string;
    workspace_id: string;
    plugin_id: string;
    provider_id: string;
    slot_id: string | null;
    label: string;
    scopes: string;
    revision: number;
    secret_ciphertext: string;
    created_at: number;
    updated_at: number;
};

type TestEvidenceRow = {
    connection_id: string;
    revision: number;
    operation_id: string;
    ok: number;
    code: string | null;
    checked_at: number;
    detail: string | null;
};

function parseStringArray(raw: string): string[] {
    try {
        const parsed = JSON.parse(raw) as unknown;
        if (!Array.isArray(parsed)) return [];
        return parsed.filter((value): value is string => typeof value === 'string');
    } catch {
        return [];
    }
}

function toConnection(row: ConnectionRow): StoredPluginConnection {
    return {
        id: row.id,
        ownerUserId: row.owner_user_id,
        workspaceId: row.workspace_id,
        pluginId: row.plugin_id,
        providerId: row.provider_id,
        ...(row.slot_id === null ? {} : { slotId: row.slot_id }),
        label: row.label,
        scopes: parseStringArray(row.scopes),
        revision: row.revision,
        secretCiphertext: row.secret_ciphertext,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
    };
}

function toEvidence(row: TestEvidenceRow): ConnectionTestEvidence {
    return {
        connectionId: row.connection_id,
        revision: row.revision,
        operationId: row.operation_id,
        ok: row.ok === 1,
        ...(row.code === null ? {} : { code: row.code as ConnectionTestEvidence['code'] }),
        checkedAt: row.checked_at,
        ...(row.detail === null ? {} : { detail: row.detail }),
    };
}

/**
 * SQLite-backed plugin connection store.
 *
 * Credentials stay encrypted here; the encryption key comes from the host
 * environment and is never written to this database.
 */
class SqlitePluginConnectionStore implements PluginConnectionStore {
    constructor(private readonly db: SqliteDatabase) {
        this.#initialize();
    }

    #initialize(): void {
        if (getSqliteDriver() !== 'turso') {
            this.db.pragma?.('journal_mode = WAL');
            this.db.pragma?.('synchronous = NORMAL');
            this.db.pragma?.('foreign_keys = ON');
        }

        this.db.exec?.(`
            CREATE TABLE IF NOT EXISTS plugin_connections (
                id TEXT PRIMARY KEY,
                owner_user_id TEXT NOT NULL,
                workspace_id TEXT NOT NULL,
                plugin_id TEXT NOT NULL,
                provider_id TEXT NOT NULL,
                slot_id TEXT,
                label TEXT NOT NULL DEFAULT '',
                scopes TEXT NOT NULL DEFAULT '[]',
                revision INTEGER NOT NULL DEFAULT 1,
                secret_ciphertext TEXT NOT NULL,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL
            );

            CREATE TABLE IF NOT EXISTS plugin_connection_tests (
                connection_id TEXT PRIMARY KEY,
                revision INTEGER NOT NULL,
                operation_id TEXT NOT NULL,
                ok INTEGER NOT NULL,
                code TEXT,
                checked_at INTEGER NOT NULL,
                detail TEXT,
                FOREIGN KEY (connection_id) REFERENCES plugin_connections(id) ON DELETE CASCADE
            );

            CREATE INDEX IF NOT EXISTS idx_plugin_connections_workspace_plugin
                ON plugin_connections (workspace_id, plugin_id);
            CREATE INDEX IF NOT EXISTS idx_plugin_connections_owner
                ON plugin_connections (owner_user_id);
        `);

        // Additive migration for databases created before slot bindings existed.
        try {
            this.db.prepare(`ALTER TABLE plugin_connections ADD COLUMN slot_id TEXT`).run();
        } catch {
            // The column is already present; nothing to migrate.
        }
    }

    /**
     * Owner-scoped listing. Ownership is part of the SQL predicate so a workspace
     * peer cannot discover another user's connections or their references.
     */
    async list(input: {
        readonly ownerUserId: string;
        readonly workspaceId: string;
        readonly pluginId?: string;
    }): Promise<readonly StoredPluginConnection[]> {
        const rows = (
            input.pluginId === undefined
                ? this.db
                      .prepare(
                          `SELECT * FROM plugin_connections WHERE owner_user_id = ? AND workspace_id = ? ORDER BY created_at ASC`
                      )
                      .all(input.ownerUserId, input.workspaceId)
                : this.db
                      .prepare(
                          `SELECT * FROM plugin_connections WHERE owner_user_id = ? AND workspace_id = ? AND plugin_id = ? ORDER BY created_at ASC`
                      )
                      .all(input.ownerUserId, input.workspaceId, input.pluginId)
        ) as ConnectionRow[];
        return rows.map(toConnection);
    }

    async get(id: string): Promise<StoredPluginConnection | null> {
        const row = this.db
            .prepare(`SELECT * FROM plugin_connections WHERE id = ?`)
            .get(id) as ConnectionRow | undefined;
        return row ? toConnection(row) : null;
    }

    /**
     * Insert-only creation. `DO NOTHING` is deliberate: an upsert here could
     * reassign an existing record's owner, workspace, plugin or provider when two
     * processes happen to generate the same id.
     */
    async insert(connection: StoredPluginConnection): Promise<boolean> {
        const result = this.db
            .prepare(
                `INSERT INTO plugin_connections (
                    id, owner_user_id, workspace_id, plugin_id, provider_id, slot_id,
                    label, scopes, revision, secret_ciphertext, created_at, updated_at
                 ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                 ON CONFLICT(id) DO NOTHING`
            )
            .run(
                connection.id,
                connection.ownerUserId,
                connection.workspaceId,
                connection.pluginId,
                connection.providerId,
                connection.slotId ?? null,
                connection.label,
                JSON.stringify(connection.scopes),
                connection.revision,
                connection.secretCiphertext,
                connection.createdAt,
                connection.updatedAt
            );
        return result.changes > 0;
    }

    /**
     * Compare-and-swap update. Identity columns are not in the SET list, so a
     * retry cannot move the record; the revision predicate is the whole
     * concurrency control.
     */
    async update(update: PluginConnectionUpdate): Promise<boolean> {
        const result = this.db
            .prepare(
                `UPDATE plugin_connections
                    SET revision = ?,
                        secret_ciphertext = ?,
                        updated_at = ?,
                        scopes = COALESCE(?, scopes),
                        label = COALESCE(?, label)
                  WHERE id = ? AND revision = ?`
            )
            .run(
                update.revision,
                update.secretCiphertext,
                update.updatedAt,
                update.scopes === undefined ? null : JSON.stringify(update.scopes),
                update.label ?? null,
                update.id,
                update.expectedRevision
            );
        return result.changes > 0;
    }

    async delete(id: string): Promise<void> {
        this.db.prepare(`DELETE FROM plugin_connections WHERE id = ?`).run(id);
        this.db
            .prepare(`DELETE FROM plugin_connection_tests WHERE connection_id = ?`)
            .run(id);
    }

    async getTestEvidence(connectionId: string): Promise<ConnectionTestEvidence | null> {
        const row = this.db
            .prepare(`SELECT * FROM plugin_connection_tests WHERE connection_id = ?`)
            .get(connectionId) as TestEvidenceRow | undefined;
        return row ? toEvidence(row) : null;
    }

    /**
     * Stores evidence only when it belongs to the connection's current revision
     * and is not older than what is already stored. A slow test that finishes
     * after a credential rotation therefore cannot reinstate itself as current
     * evidence, and an older completion cannot replace a newer result.
     */
    async setTestEvidence(evidence: ConnectionTestEvidence): Promise<boolean> {
        const result = this.db
            .prepare(
                `INSERT INTO plugin_connection_tests (
                    connection_id, revision, operation_id, ok, code, checked_at, detail
                 )
                 SELECT ?, ?, ?, ?, ?, ?, ?
                  WHERE EXISTS (
                        SELECT 1 FROM plugin_connections
                         WHERE id = ? AND revision = ?
                  )
                 ON CONFLICT(connection_id) DO UPDATE SET
                    revision = excluded.revision,
                    operation_id = excluded.operation_id,
                    ok = excluded.ok,
                    code = excluded.code,
                    checked_at = excluded.checked_at,
                    detail = excluded.detail
                  WHERE excluded.revision > plugin_connection_tests.revision
                     OR (excluded.revision = plugin_connection_tests.revision
                         AND excluded.checked_at >= plugin_connection_tests.checked_at)`
            )
            .run(
                evidence.connectionId,
                evidence.revision,
                evidence.operationId,
                evidence.ok ? 1 : 0,
                evidence.code ?? null,
                evidence.checkedAt,
                evidence.detail ?? null,
                evidence.connectionId,
                evidence.revision
            );
        return result.changes > 0;
    }
}

export function createSqlitePluginConnectionStore(
    options: { database?: SqliteDatabase } = {}
): PluginConnectionStore {
    const db = options.database ?? getRawDb();
    return new SqlitePluginConnectionStore(db);
}
