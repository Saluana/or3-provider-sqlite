import type { Kysely } from 'kysely';

/** The same browser device ID can be used by several accounts. Unowned legacy
 * cursors remain untouched and expire under the existing retention policy.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
    await db.schema.dropIndex('idx_device_cursors_ws_device').ifExists().execute();
    await db.schema.createIndex('idx_device_cursors_ws_user_device').ifNotExists()
        .on('device_cursors').columns(['workspace_id', 'owner_user_id', 'device_id']).unique().execute();
}

export async function down(_db: Kysely<unknown>): Promise<void> {
    // The old unique key cannot represent multiple users of one browser safely.
}
