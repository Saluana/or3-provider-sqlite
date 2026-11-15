import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID, createHash } from 'node:crypto';
import type { H3Event } from 'h3';
import { initializeSqliteDb, destroySqliteDb, getRawDb, _resetForTest } from '../server/db/kysely';
import { runMigrations } from '../server/db/migrate';
import { createD1TestDatabase } from '../../../test/support/d1-test-database';
import { sqliteSyncAdminAdapter } from '../server/admin/adapters/sync-sqlite';
import { SqliteBackgroundJobProvider } from '../server/background-jobs/sqlite-provider';
import { SqliteSyncGatewayAdapter } from '../server/sync/sqlite-sync-gateway-adapter';
import { stableJson } from '../server/sync/background-history-fingerprint';
import type { ChatGenerationAdmissionEnvelope } from '~~/shared/chat/background-history';
import type { PendingOp } from '~~/shared/sync/types';
import { SnapshotResponseSchema, PullResponseSchema, compareSyncTuple } from '~~/shared/sync/schemas';
const scope = { workspaceId: 'hardening' };
const event = {} as H3Event;
const op = (pk: string, payload: Record<string, unknown> = {}): PendingOp => ({
    id: randomUUID(), tableName: 'kv', pk, operation: 'put',
    payload: { id: pk, name: pk, value: 'ok', created_at: 1, updated_at: 1, ...payload },
    stamp: { opId: randomUUID(), deviceId: 'test', clock: 1, hlc: 'legacy:1' },
    createdAt: 1, attempts: 0, status: 'pending',
});
let adapter: SqliteSyncGatewayAdapter;
let d1: ReturnType<typeof createD1TestDatabase> | undefined;
let raw: ReturnType<typeof getRawDb>;
afterEach(async () => { await destroySqliteDb(); d1?.close(); d1 = undefined; });
describe.each(['native', 'd1'])('%s matched sync contract', driver => {
    beforeEach(async () => {
        _resetForTest();
        if (driver === 'd1') d1 = createD1TestDatabase();
        const db = await initializeSqliteDb(d1 ? { driver: 'd1', d1Database: d1.database } : { path: ':memory:' });
        await runMigrations(db);
        raw = d1 ? { prepare: (query: string) => ({ run: (...parameters: unknown[]) => d1!.database.prepare(query).bind(...parameters).run(), get: async (...parameters: unknown[]) => (await d1!.database.prepare(query).bind(...parameters).all()).results?.[0] }) } as unknown as ReturnType<typeof getRawDb> : getRawDb();
        adapter = new SqliteSyncGatewayAdapter();
    });
    it('rejects invalid final payloads without allocating state and persists one normalized row/log value', async () => {
        const invalid = op('bad', { name: 42 });
        expect((await adapter.push(event, { scope, ops: [invalid] })).results[0]).toMatchObject({ success: false, errorCode: 'VALIDATION_ERROR' });
        expect(await raw.prepare('SELECT count(*) AS n FROM change_log').get()).toEqual({ n: 0 });
        expect(await raw.prepare('SELECT count(*) AS n FROM server_version_counter').get()).toEqual({ n: 0 });
        const edge = op('edge');
        (edge.payload as Record<string,unknown>).value = 'x'.repeat(262144 - Buffer.byteLength(JSON.stringify(edge.payload)));
        expect((await adapter.push(event,{scope,ops:[edge]})).results[0]).toMatchObject({success:false,errorCode:'VALIDATION_ERROR'});
        expect(await raw.prepare('SELECT count(*) AS n FROM server_version_counter').get()).toEqual({n:0});
        const good = op('good');
        expect((await adapter.push(event, { scope, ops: [good] })).results[0]?.success).toBe(true);
        const row = await raw.prepare('SELECT data_json FROM s_kv').get() as { data_json: string };
        const log = await raw.prepare('SELECT payload_json FROM change_log').get() as { payload_json: string };
        expect(row.data_json).toBe(log.payload_json);
        expect(JSON.parse(row.data_json)).toMatchObject({ clock: 1, hlc: good.stamp.hlc, op_id: good.stamp.opId });
        expect((await adapter.push(event, { scope, ops: [good] })).results[0]).toMatchObject({ success: true, serverVersion: 1 });
    });
    it('acknowledges a lost ACK from 0.0.30 before new normalization', async () => {
        const legacy = op('legacy');
        await raw.prepare(`INSERT INTO change_log (id,workspace_id,server_version,table_name,pk,op,payload_json,clock,hlc,device_id,op_id,created_at)
            VALUES (?, ?, 1, 'kv', ?, 'put', ?, 1, ?, 'test', ?, 1)`).run(randomUUID(),scope.workspaceId,legacy.pk,JSON.stringify(legacy.payload),legacy.stamp.hlc,legacy.stamp.opId);
        await raw.prepare('INSERT INTO server_version_counter VALUES (?,1)').run(scope.workspaceId);
        expect((await adapter.push(event, { scope, ops: [legacy] })).results[0]).toMatchObject({ success: true, serverVersion: 1 });
    });
    it('preserves exact legacy delete intent on lost-ACK replay', async () => {
        const legacy = {...op('deleted'),operation:'delete' as const,payload:{deletedAt:123,extensionKey:'original'}};
        await raw.prepare(`INSERT INTO change_log (id,workspace_id,server_version,table_name,pk,op,payload_json,clock,hlc,device_id,op_id,created_at)
            VALUES (?, ?, 1, 'kv', ?, 'delete', ?, 1, ?, 'test', ?, 1)`).run(randomUUID(),scope.workspaceId,legacy.pk,JSON.stringify(legacy.payload),legacy.stamp.hlc,legacy.stamp.opId);
        await raw.prepare('INSERT INTO server_version_counter VALUES (?,1)').run(scope.workspaceId);
        expect((await adapter.push(event,{scope,ops:[legacy]})).results[0]).toMatchObject({success:true,serverVersion:1});
        const fresh = {...legacy,id:randomUUID(),pk:'fresh',stamp:{...legacy.stamp,opId:randomUUID()}};
        expect((await adapter.push(event,{scope,ops:[fresh]})).results[0]?.success).toBe(true);
        expect(await raw.prepare("SELECT payload_json FROM change_log WHERE pk = 'fresh'").get()).toEqual({payload_json:JSON.stringify(legacy.payload)});
        expect(await raw.prepare('SELECT count(*) AS n FROM change_log').get()).toEqual({n:2});
    });
    it('reads legacy message ordering without changing original bytes or retaining healthy evidence', async () => {
        const payload = {id:'legacy-message',thread_id:'thread',role:'assistant',index:0,clock:1,created_at:1,updated_at:1,deleted:false};
        const opId = randomUUID(); const bytes = JSON.stringify(payload);
        await raw.prepare(`INSERT INTO change_log (id,workspace_id,server_version,table_name,pk,op,payload_json,clock,hlc,device_id,op_id,created_at)
            VALUES (?, ?, 1, 'messages', 'legacy-message', 'put', ?, 1, 'legacy:1', 'test', ?, 1)`).run(randomUUID(),scope.workspaceId,bytes,opId);
        await raw.prepare(`INSERT INTO s_messages (id,workspace_id,data_json,clock,hlc,device_id,op_id,deleted,created_at,updated_at)
            VALUES ('legacy-message',?, ?,1,'legacy:1','test',?,0,1,1)`).run(scope.workspaceId,bytes,opId);
        await raw.prepare('INSERT INTO server_version_counter VALUES (?,1)').run(scope.workspaceId);
        const pull = await adapter.pull(event,{scope,cursor:0,limit:100});
        expect(pull.unavailable ?? []).toEqual([]); expect(pull.changes[0]?.payload).toEqual(payload);
        const snapshot = await adapter.snapshot(event,{scope,tables:['messages'],pageSize:1});
        expect(snapshot.unavailable ?? []).toEqual([]); expect(snapshot.items[0]).toMatchObject({payload});
        expect(snapshot.items[0] && 'payload' in snapshot.items[0] && snapshot.items[0].payload).toEqual(payload);
        expect(await raw.prepare('SELECT count(*) AS n FROM sync_unavailable_records').get()).toEqual({n:0});
        expect(await raw.prepare('SELECT data_json FROM s_messages').get()).toEqual({data_json:bytes});
    });
    it.runIf(driver === 'native')('keeps historical background admission receipt identity and derives ordering only for new final writes', async () => {
        const history = {version:1,kind:'new-turn',admissionId:'legacy-admission',generationId:'legacy-generation',workspaceId:scope.workspaceId,threadId:'thread',messageId:'assistant',
            thread:{id:'thread',clock:1,status:'ready',pinned:false,deleted:false,created_at:1,updated_at:1,extensionKey:'original'},
            userMessage:{id:'user',thread_id:'thread',clock:1,role:'user',index:0,deleted:false,created_at:1,updated_at:1,extensionKey:'original'},
            assistantMessage:{id:'assistant',thread_id:'thread',clock:1,role:'assistant',index:1,deleted:false,created_at:1,updated_at:1,extensionKey:'original',data:{generation_id:'legacy-generation'}}} as ChatGenerationAdmissionEnvelope;
        const fingerprint = createHash('sha256').update(stableJson({...history,expectedAssistant:undefined})).digest('hex');
        await raw.prepare('INSERT INTO workspace_members (id,workspace_id,user_id,role) VALUES (?,?,?,?)').run('member',scope.workspaceId,'owner','owner');
        await raw.prepare(`INSERT INTO background_generation_receipts (id,workspace_id,generation_id,stage,fingerprint,outcome,server_version,created_at)
            VALUES (?,?,?,'admission',?,'admitted',3,1)`).run(randomUUID(),scope.workspaceId,history.generationId,fingerprint);
        await raw.prepare('INSERT INTO server_version_counter VALUES (?,3)').run(scope.workspaceId);
        const actor = {workspaceId:scope.workspaceId,userId:'owner'};
        const original = JSON.stringify(history);
        expect(await adapter.admitChatGeneration(actor,history)).toMatchObject({replayed:true,serverVersion:3});
        expect(await raw.prepare('SELECT count(*) AS n FROM change_log').get()).toEqual({n:0});
        expect(await raw.prepare('SELECT fingerprint FROM background_generation_receipts').get()).toEqual({fingerprint});
        const provider = new SqliteBackgroundJobProvider();
        await expect(provider.createJob({userId:'owner',threadId:'thread',messageId:'assistant',model:'test',kind:'chat',generationId:history.generationId,
            execution:{version:1,workspaceId:scope.workspaceId,body:{model:'test',messages:[]},apiKeyCiphertext:'test',referer:'https://example.test',history}} as never)).resolves.toEqual(expect.any(String));
        expect(JSON.stringify(history)).toBe(original);
        history.generationId = 'fresh-generation';
        history.assistantMessage.data = {generation_id:history.generationId};
        expect(await adapter.admitChatGeneration(actor,history)).toMatchObject({replayed:false,serverVersion:6});
        const row = await raw.prepare("SELECT data_json FROM s_messages WHERE id = 'assistant'").get() as {data_json:string};
        const log = await raw.prepare("SELECT payload_json FROM change_log WHERE pk = 'assistant'").get() as {payload_json:string};
        expect(log.payload_json).toBe(row.data_json);
        expect(JSON.parse(row.data_json).order_key).toBe(JSON.parse(row.data_json).hlc);
        await raw.prepare("UPDATE s_messages SET data_json = json_remove(data_json, '$.order_key') WHERE id = 'assistant'").run();
        const finalized = await adapter.finalizeChatGeneration(actor,{admission:history,snapshot:{status:'complete',content:'answer',reasoning:'',completedAt:1800000000000}});
        expect(finalized).toMatchObject({status:'committed',replayed:false,serverVersion:7});
        const finalRow = await raw.prepare("SELECT data_json FROM s_messages WHERE id = 'assistant'").get() as {data_json:string};
        const finalLog = await raw.prepare("SELECT payload_json FROM change_log WHERE server_version = 7").get() as {payload_json:string};
        expect(finalRow.data_json).toBe(finalLog.payload_json);
        expect(JSON.parse(finalRow.data_json).order_key).toBe(JSON.parse(finalRow.data_json).hlc);
        history.generationId = 'legacy-generation';history.assistantMessage.data = {generation_id:history.generationId};expect(JSON.stringify(history)).toBe(original);
    });
    it('pages UTF-8 component keys including NUL prefixes and maximum escaped tokens', async () => {
        const keys = ['a', 'a\0b', '\uE000', '\u{10000}', '😀', '界'.repeat(1024), ':'.repeat(1024), '\0'.repeat(1024), '\u{10ffff}'];
        expect((await adapter.push(event, { scope, ops: keys.map(key => op(key)) })).results.every(result => result.success)).toBe(true);
        const seen: string[] = []; let pageToken: string | undefined;
        do {
            const page = await adapter.snapshot(event, { scope, tables: ['kv'], pageSize: 1, ...(pageToken ? { pageToken } : {}) });
            expect(SnapshotResponseSchema.safeParse(page).success).toBe(true);
            seen.push(...page.items.map(item => item.pk)); pageToken = page.nextPageToken ?? undefined;
        } while (pageToken);
        const expected = [...keys].sort((a,b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
        expect(seen).toEqual(expected);
        expect([...keys].sort((a,b)=>compareSyncTuple(['kv',a,'row'],['kv',b,'row']))).toEqual(expected);
        const together = await adapter.snapshot(event,{scope,tables:['kv'],pageSize:100});
        expect(SnapshotResponseSchema.safeParse(together).success).toBe(true);
        expect(together.items.map(item=>item.pk)).toEqual(expected);
        const invalid = op('\uD800');
        expect((await adapter.push(event,{scope,ops:[invalid]})).results[0]).toMatchObject({success:false,errorCode:'VALIDATION_ERROR'});
        expect(await raw.prepare('SELECT count(*) AS n FROM s_kv').get()).toEqual({n:keys.length});
    });
    it('retains poison and oversized originals before all-invalid pull progress and snapshot completion', async () => {
        await adapter.push(event, { scope, ops: [op('broken'), op('huge'), op('healthy')] });
        await raw.prepare("UPDATE change_log SET payload_json = '{bad' WHERE pk = 'broken'").run();
        await raw.prepare("UPDATE s_kv SET data_json = '{bad' WHERE id = 'broken'").run();
        const huge = JSON.stringify({ padding: 'x'.repeat(300000) });
        await raw.prepare("UPDATE change_log SET payload_json = ? WHERE pk = 'huge'").run(huge);
        await raw.prepare("UPDATE s_kv SET data_json = ? WHERE id = 'huge'").run(huge);
        let largestPayload = 0;
        const prepare = d1?.database.prepare.bind(d1.database);
        const account = (rows: unknown[]) => {for (const row of rows) {
            const payload = (row as {payload_json?:string|null}).payload_json;
            if (typeof payload === 'string') largestPayload = Math.max(largestPayload,Buffer.byteLength(payload));
        }};
        const observe = (statement: ReturnType<NonNullable<typeof prepare>>): ReturnType<NonNullable<typeof prepare>> => {
            const bind = statement.bind.bind(statement); const all = statement.all.bind(statement);
            statement.bind = (...values)=>observe(bind(...values));
            statement.all = async <T>()=>{const result = await all<T>();account(result.results ?? []);return result;};
            return statement;
        };
        const nativePrepare = driver === 'native' ? raw.prepare.bind(raw) : undefined;
        const readSpy = d1 && prepare ? vi.spyOn(d1.database,'prepare').mockImplementation(query=>observe(prepare(query)))
            : vi.spyOn(raw,'prepare').mockImplementation(query=>{
                const statement = nativePrepare!(query); const all = statement.all.bind(statement);
                statement.all = (...parameters)=>{const rows = all(...parameters);account(rows);return rows;};return statement;
            });
        let pull;
        try { pull = await adapter.pull(event, { scope, cursor: 0, limit: 2 }); }
        finally {readSpy?.mockRestore();}
        expect(largestPayload).toBeLessThanOrEqual(262144);
        expect(largestPayload).toBeGreaterThanOrEqual(4);

        expect(PullResponseSchema.safeParse(pull).success).toBe(true);
        expect(pull).toMatchObject({ changes: [], nextCursor: 2, hasMore: true, unavailable: [
            { pk: 'broken', originalKind: 'put', serverVersion: 1 }, { pk: 'huge', originalKind: 'put', serverVersion: 2 },
        ] });
        const digest = createHash('sha256');
        for (let offset = 0; offset < Buffer.byteLength(huge); offset += 32768) {
            const chunk = await adapter.maintainUnavailableRecords(event,scope.workspaceId,'export',{id:pull.unavailable![1]!.evidenceRef,offset});
            expect((chunk.payloadHex as string).length).toBeLessThanOrEqual(65536);
            digest.update(Buffer.from(chunk.payloadHex as string,'hex'));
        }
        expect(digest.digest('hex')).toBe(createHash('sha256').update(huge).digest('hex'));
        const refs = pull.unavailable!.map(marker => marker.evidenceRef);
        expect((await adapter.pull(event, { scope, cursor: 0, limit: 2 })).unavailable!.map(marker => marker.evidenceRef)).toEqual(refs);
        const snapshot = await adapter.snapshot(event, { scope, tables: ['kv'], pageSize: 3 });
        expect(SnapshotResponseSchema.safeParse(snapshot).success).toBe(true);
        expect(snapshot.items.map(item => item.pk)).toEqual(['healthy']);
        expect(snapshot.unavailable?.length).toBe(2);
        expect(snapshot.nextPageToken).toBeNull();
        await raw.prepare('DELETE FROM change_log').run(); await raw.prepare('DELETE FROM sync_snapshots').run();
        expect(await raw.prepare('SELECT count(*) AS n FROM sync_unavailable_records').get()).toEqual({ n: 4 });
    });
    it.each(['uuid','payload','table'])('contains a %s defect inside a healthy pull window', async fault => {
        await adapter.push(event,{scope,ops:[op('before'),op('bad'),op('after')]});
        if (fault === 'uuid') await raw.prepare("UPDATE change_log SET op_id = 'invalid-uuid' WHERE pk = 'bad'").run();
        if (fault === 'payload') await raw.prepare("UPDATE change_log SET payload_json = json_set(payload_json,'$.name',42) WHERE pk = 'bad'").run();
        if (fault === 'table') await raw.prepare("UPDATE change_log SET table_name = 'unknown_table' WHERE pk = 'bad'").run();
        const page = await adapter.pull(event,{scope,cursor:0,limit:3});
        expect(PullResponseSchema.safeParse(page).success).toBe(true);
        expect(page.changes.map(change=>change.pk)).toEqual(['before','after']);
        expect(page).toMatchObject({nextCursor:3,hasMore:false,unavailable:[{pk:'bad',serverVersion:2}]});
        const retained = await raw.prepare('SELECT payload_json,metadata_json FROM sync_unavailable_records WHERE id = ?').get(page.unavailable![0]!.evidenceRef) as {payload_json:string;metadata_json:string};
        const original = await raw.prepare("SELECT payload_json FROM change_log WHERE pk = 'bad'").get() as {payload_json:string};
        expect(retained.payload_json).toBe(original.payload_json);
        expect(JSON.parse(retained.metadata_json)).toMatchObject({pk:'bad',server_version:2});
    });
    it('retains invalid deletion metadata at a page boundary and completes the final all-invalid snapshot page', async () => {
        const put = op('a-deleted'); await adapter.push(event,{scope,ops:[put,op('z-invalid')]});
        await adapter.push(event,{scope,ops:[{...put,id:randomUUID(),operation:'delete',payload:undefined,stamp:{...put.stamp,clock:2,opId:randomUUID()}}]});
        await raw.prepare("UPDATE s_kv SET clock = -1 WHERE id = 'a-deleted'").run();
        await raw.prepare("UPDATE s_kv SET data_json = '{bad' WHERE id = 'z-invalid'").run();
        const first = await adapter.snapshot(event,{scope,tables:['kv'],pageSize:1});
        expect(SnapshotResponseSchema.safeParse(first).success).toBe(true);
        expect(first).toMatchObject({items:[],unavailable:[{pk:'a-deleted',originalKind:'tombstone'}]});
        expect(first.nextPageToken).toEqual(expect.any(String));
        const last = await adapter.snapshot(event,{scope,tables:['kv'],pageSize:1,pageToken:first.nextPageToken!});
        expect(last).toMatchObject({items:[],unavailable:[{pk:'z-invalid',originalKind:'row'}],nextPageToken:null});
        expect(await raw.prepare('SELECT count(*) AS n FROM sync_unavailable_records').get()).toEqual({n:2});
    });
    it('finishes an all-invalid final snapshot page, retains unknown owners privately and guards backup JSON', async () => {
        await adapter.push(event, { scope, ops: [op('only')] });
        await raw.prepare("UPDATE s_kv SET data_json = '{bad'").run();
        const page = await adapter.snapshot(event, { scope, tables: ['kv'], pageSize: 1 });
        expect(page).toMatchObject({ items: [], unavailable: [{ pk: 'only', originalKind: 'row' }], nextPageToken: null });
        await raw.prepare(`INSERT INTO s_notifications (id,workspace_id,data_json,clock,hlc,device_id,op_id,deleted,created_at,updated_at)
            VALUES ('secret',?, '{bad',1,'legacy:1','test',?,0,1,1)`).run(scope.workspaceId,randomUUID());
        const notifications = await adapter.snapshot(event, { scope, tables: ['notifications'], pageSize:10 });
        expect(notifications.items).toEqual([]); expect(notifications.unavailable ?? []).toEqual([]);
        expect(await raw.prepare("SELECT count(*) AS n FROM sync_unavailable_records WHERE source = 'canonical'").get()).toEqual({n:1});
        await raw.prepare(`INSERT INTO s_file_meta (id,workspace_id,data_json,clock,hlc,device_id,op_id,deleted,created_at,updated_at)
            VALUES ('file',?, ?,1,'legacy:1','test',?,1,1,1)`).run(scope.workspaceId,JSON.stringify({unexpected:'original'}),randomUUID());
        const backup = await adapter.backupSnapshot(event, { scope, tables: ['file_meta'], pageSize:10 });
        expect(backup).toMatchObject({ items: [], unavailable: [{ pk: 'file' }], nextPageToken: null });
        const original = await adapter.maintainUnavailableRecords(event,scope.workspaceId,'export',{id:backup.unavailable![0]!.evidenceRef});
        expect(Buffer.from(original.payloadHex as string,'hex').toString()).toBe(JSON.stringify({unexpected:'original'}));
    });
    it('fails coverage for an untrustworthy identity or version and fails closed when evidence cannot persist', async () => {
        await adapter.push(event, { scope, ops: [op('bad')] });
        await adapter.push(event,{scope,ops:[op('duplicate')]});
        await raw.prepare("UPDATE change_log SET server_version = 1 WHERE pk = 'duplicate'").run();
        await expect(adapter.pull(event,{scope,cursor:0,limit:1})).rejects.toThrow('version');
        await raw.prepare("DELETE FROM change_log WHERE pk = 'duplicate'").run();
        await raw.prepare("UPDATE change_log SET server_version = 1.5").run();
        await expect(adapter.pull(event, {scope,cursor:0,limit:100})).rejects.toThrow();
        await raw.prepare("UPDATE change_log SET server_version = 1, pk = ''").run();
        await expect(adapter.pull(event, {scope,cursor:0,limit:100})).rejects.toThrow('identity');
        await raw.prepare("UPDATE change_log SET pk = 'bad', payload_json = '{bad'").run();
        await raw.prepare(`CREATE TRIGGER fail_evidence BEFORE INSERT ON sync_unavailable_records BEGIN SELECT RAISE(ABORT,'evidence storage failure'); END`).run();
        await expect(adapter.pull(event, {scope,cursor:0,limit:100})).rejects.toThrow('evidence storage failure');
    });
    it('verifies fallback source identity and notification visibility before retaining reader evidence', async () => {
        await adapter.push(event,{scope,ops:[op('fallback')]});
        const page = await adapter.pull(event,{scope,cursor:0,limit:100}); const record = page.changes[0]!;
        const marker = {tableName: 'kv', pk:'fallback',originalKind:'put' as const,serverVersion:1,reason:'reader_invalid'};
        const retained = await adapter.retainUnavailableRecord(event,{scope,source:'pull',record,marker});
        expect(retained.evidenceRef).toBeTruthy();
        await expect(adapter.retainUnavailableRecord(event,{scope,source:'pull',record,marker:{...marker,pk:'forged'}})).rejects.toThrow();
    });
    it('exports evidence in bounded chunks and repairs only the current revision atomically with a fresh winning operation', async () => {
        await adapter.push(event,{scope,ops:[op('repair')]});
        await raw.prepare("UPDATE change_log SET payload_json = '{bad'").run();
        await raw.prepare("UPDATE s_kv SET data_json = '{bad'").run();
        const marker = (await adapter.pull(event,{scope,cursor:0,limit:100})).unavailable![0]!;
        const admin = (action: string,input: Record<string,unknown>) => sqliteSyncAdminAdapter.runAction!(event,`sync.evidence-${action}`,input,{session:{workspace:{id:scope.workspaceId}}} as never) as Promise<Record<string,unknown>>;
        const inspect = await admin('inspect',{});
        expect(inspect).toMatchObject({items:[{id:marker.evidenceRef,status:'unresolved'}]});
        expect(await adapter.maintainUnavailableRecords(event,scope.workspaceId,'export',{id:marker.evidenceRef})).toMatchObject({payloadHex:Buffer.from('{bad').toString('hex').toUpperCase()});
        expect(await adapter.maintainUnavailableRecords(event,scope.workspaceId,'revalidate',{id:marker.evidenceRef})).toMatchObject({valid:false});
        const replacement = {...op('repair').payload as object};
        const repaired = await admin('repair',{id:marker.evidenceRef,payload:replacement});
        expect(repaired).toMatchObject({status:'repaired',serverVersion:2});
        const fresh = (await adapter.pull(event,{scope,cursor:1,limit:100})).changes[0]!;
        expect(fresh.stamp.clock).toBe(2); expect(fresh.stamp.opId).toMatch(/^[0-9a-f-]{36}$/);
        expect(await raw.prepare('SELECT status,resolved_op_id FROM sync_unavailable_records WHERE id = ?').get(marker.evidenceRef)).toEqual({status:'repaired',resolved_op_id:fresh.stamp.opId});
        // Reprocessing old evidence cannot overwrite the healthy winner.
        expect(await adapter.maintainUnavailableRecords(event,scope.workspaceId,'repair',{id:marker.evidenceRef,payload:replacement})).toMatchObject({status:'repaired'});
        expect((await adapter.pull(event,{scope,cursor:2,limit:100})).changes).toEqual([]);
        // Oversized revision/metadata evidence remains available through bounded
        // inspection and chunk export, without putting the whole revision in UI JSON.
        await adapter.push(event,{scope,ops:[op('oversized-metadata')]});
        await raw.prepare("UPDATE s_kv SET hlc = ? WHERE id = 'oversized-metadata'").run('h'.repeat(300000));
        const snapshot = await adapter.snapshot(event,{scope,tables:['kv'],pageSize:10});
        const metadataId = snapshot.unavailable!.find(marker=>marker.pk === 'oversized-metadata')!.evidenceRef;
        const rows = (await admin('inspect',{})).items as Array<{id:string;revision:string|null}>;
        expect(rows.find(row=>row.id === metadataId)?.revision).toBeNull();
        const chunk = await admin('export',{id:metadataId});
        expect((chunk.metadataHex as string).length).toBe(65536);
        expect(chunk.totalBytes).toBeGreaterThan(300000);
    });

    it.each(['payload','hlc','device','index','timestamp'])('rejects invalid background %s before durable job acceptance', async fault => {
        const history = {version:1,kind:'new-turn',admissionId:'admission',generationId:'generation',workspaceId:scope.workspaceId,threadId:'thread',messageId:'assistant',
            thread:{id:'thread',clock:1,status:'ready',pinned:false,deleted:false,created_at:1,updated_at:1},
            userMessage:{id:'user',thread_id:'thread',clock:1,role:'user',index:0,order_key:'a0',deleted:false,created_at:1,updated_at:1},
            assistantMessage:{id:'assistant',thread_id:'thread',clock:1,role:fault === 'payload' ? 42 : 'assistant',index:1,order_key:'a1',deleted:false,created_at:1,updated_at:1,
                ...(fault === 'hlc' ? {hlc:'x'.repeat(513)} : {})}};
        if (fault === 'index') delete (history.assistantMessage as Partial<typeof history.assistantMessage>).index;
        if (fault === 'timestamp') delete (history.assistantMessage as Partial<typeof history.assistantMessage>).updated_at;
        if (fault === 'device') history.generationId = 'g'.repeat(246);
        const provider = new SqliteBackgroundJobProvider();
        await expect(provider.createJob({userId:'test',threadId:'thread',messageId:'assistant',model:'test',kind:'chat',generationId:'generation',
            execution:{version:1,workspaceId:scope.workspaceId,body:{model:'test',messages:[]},apiKeyCiphertext:'test',referer:'https://example.test',history}} as never)).rejects.toThrow();
        expect(await raw.prepare('SELECT count(*) AS n FROM background_jobs').get()).toEqual({n:0});
    });

    it('keeps evidence unresolved after invalid repair and fences a concurrent healthy winner', async () => {
        await adapter.push(event,{scope,ops:[op('race')]});
        await raw.prepare("UPDATE change_log SET payload_json = '{bad'").run();
        await raw.prepare("UPDATE s_kv SET data_json = '{bad'").run();
        const id = (await adapter.pull(event,{scope,cursor:0,limit:100})).unavailable![0]!.evidenceRef;
        await expect(adapter.maintainUnavailableRecords(event,scope.workspaceId,'repair',{id,payload:{id:'race',name:42}})).rejects.toThrow();
        expect(await raw.prepare('SELECT value FROM server_version_counter').get()).toEqual({value:1});
        expect(await raw.prepare('SELECT status FROM sync_unavailable_records WHERE id = ?').get(id)).toEqual({status:'unresolved'});
        const push = adapter.push.bind(adapter); let raced = false;
        const spy = vi.spyOn(adapter,'push').mockImplementation(async (event,input,guard) => {
            if (guard && !raced) { raced = true; const healthy = op('race',{value:'newer'});healthy.stamp.clock = 3;await push(event,{scope,ops:[healthy]}); }
            return push(event,input,guard);
        });
        try { await expect(adapter.maintainUnavailableRecords(event,scope.workspaceId,'repair',{id,payload:op('race').payload})).rejects.toThrow(); }
        finally { spy.mockRestore(); }
        expect(await adapter.maintainUnavailableRecords(event,scope.workspaceId,'repair',{id,payload:op('race').payload})).toMatchObject({status:'superseded'});
        const healthy = (await adapter.pull(event,{scope,cursor:1,limit:100})).changes;
        expect(healthy).toHaveLength(1);expect(healthy[0]).toMatchObject({stamp:{clock:3},payload:{value:'newer'}});
        expect(await raw.prepare('SELECT value FROM server_version_counter').get()).toEqual({value:2});
    });
    it('contains notification defects without exposing a foreign or unknown owner identity', async () => {
        for (const [pk,owner] of [['mine','alice'],['foreign','bob'],['unknown',null]] as const) {
            await raw.prepare(`INSERT INTO s_notifications (id,workspace_id,data_json,clock,hlc,device_id,op_id,deleted,created_at,updated_at)
                VALUES (?,?,?,1,'legacy:1','test',?,0,1,1)`).run(pk,scope.workspaceId,JSON.stringify({id:pk,user_id:owner,type:42}),randomUUID());
        }
        const alice = {context:{__or3_session_context_test:{authenticated:true,user:{id:'alice'},workspace:{id:scope.workspaceId}}}} as unknown as H3Event;
        let version = 0;
        for (const pk of ['mine','foreign','unknown']) {
            await raw.prepare(`INSERT INTO change_log (id,workspace_id,server_version,table_name,pk,op,payload_json,clock,hlc,device_id,op_id,created_at)
                SELECT ?,workspace_id,?,'notifications',id,'put',data_json,clock,hlc,device_id,op_id,created_at FROM s_notifications WHERE id = ?`).run(randomUUID(),++version,pk);
        }
        await raw.prepare('INSERT INTO server_version_counter VALUES (?,?)').run(scope.workspaceId,version);
        const pull = await adapter.pull(alice,{scope,cursor:0,limit:3});
        expect(pull).toMatchObject({changes:[],nextCursor:3,hasMore:false});
        expect(pull.unavailable?.map(marker=>marker.pk)).toEqual(['mine']);
        const page = await adapter.snapshot(alice,{scope,tables:['notifications'],pageSize:10});
        expect(page.items).toEqual([]);expect(page.unavailable?.map(marker=>marker.pk)).toEqual(['mine']);
        expect(await raw.prepare('SELECT count(*) AS n FROM sync_unavailable_records').get()).toEqual({n:5});
    });

});
