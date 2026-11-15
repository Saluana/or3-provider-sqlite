import { sql, type Kysely } from 'kysely';
import { digestUuid } from '../../utils/digest-uuid';

/** Repair the exact legacy writer format without changing versions or clocks. */
export async function up(db: Kysely<unknown>): Promise<void> {
    const tables = [
        ['change_log', 'payload_json'],
        ['s_kv', 'data_json'],
        ['sync_snapshot_items', 'payload_json'],
        ['tombstones', null],
    ] as const;
    for (const [table, payload] of tables) {
        let after = '';
        for (;;) {
            const { rows } = await sql<{ op_id: string }>`SELECT DISTINCT op_id FROM ${sql.table(table)}
                WHERE op_id LIKE 'background-tool:%' AND op_id > ${after} ORDER BY op_id LIMIT 500`.execute(db);
            if (!rows.length) break;
            for (const { op_id: oldId } of rows) {
                const match = /^background-tool:([a-f0-9]{64})$/.exec(oldId);
                if (!match) continue;
                const opId = digestUuid(match[1]!);
                const assignment = payload
                    ? sql`, ${sql.ref(payload)} = CASE WHEN json_extract(${sql.ref(payload)}, '$.op_id') = ${oldId}
                        THEN json_set(${sql.ref(payload)}, '$.op_id', ${opId}) ELSE ${sql.ref(payload)} END`
                    : sql``;
                await sql`UPDATE ${sql.table(table)} SET op_id = ${opId}${assignment} WHERE op_id = ${oldId}`.execute(db);
            }
            after = rows.at(-1)!.op_id;
        }
    }
}

// Keep repaired operation identities on downgrade; reverting them breaks sync.
export async function down(_db: Kysely<unknown>): Promise<void> {}
