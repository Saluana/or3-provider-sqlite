import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp, toWebHandler } from 'h3';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { H3Event } from 'h3';
import type { PendingOp, PushBatch } from '~~/shared/sync/types';
import { initializeSqliteDb, destroySqliteDb, getRawDb, _resetForTest } from '../server/db/kysely';
import { runMigrations } from '../server/db/migrate';
import { createD1TestDatabase } from '../../../test/support/d1-test-database';
import { SqliteSyncGatewayAdapter } from '../server/sync/sqlite-sync-gateway-adapter';
import { readHistoryIncarnation } from '../server/sync/history-incarnation';

const scope = { workspaceId: 'push-containment' };
const event = { context: { __or3_session_context_test: { user: { id: 'owner' }, workspace: { id: scope.workspaceId } } } } as unknown as H3Event;
function op(pk: string, clock = 1): PendingOp {
    const opId = randomUUID(); const hlc = `legacy:${clock}`;
    return {id: randomUUID(), tableName:'kv',pk,operation:'put',
        payload:{id:pk,name:pk,value:'original',created_at:1,updated_at:1,deleted:false,clock,hlc,op_id:opId},
        stamp:{opId,clock,hlc,deviceId:'test'},createdAt:1,attempts:0,status:'pending'};
}
let d1: ReturnType<typeof createD1TestDatabase> | undefined;
let adapter: SqliteSyncGatewayAdapter;
let history: string;
let http: ReturnType<typeof toWebHandler> | undefined;
async function hostHttp() {
    const host = process.env.OR3_PROJECT_HOST_ROOT!;
    const mock = (path: string, factory: () => Record<string, unknown>) => vi.doMock(join(host,path),factory);
    mock('server/utils/security/cloud-mutation.ts', () => ({requireCloudMutation:()=>{}}));
    mock('server/auth/session.ts', () => ({resolveSessionContext:(request:H3Event)=>{
        const session={authenticated:true,user:{id:'owner'},workspace:{id:scope.workspaceId}};
        request.context.__or3_session_context_test=session; return session;
    }}));
    mock('server/auth/can.ts', () => ({requireCan:()=>{}}));
    mock('server/utils/auth/is-ssr-auth-enabled.ts', () => ({isSsrAuthEnabled:()=>true}));
    mock('server/utils/sync/is-sync-enabled.ts', () => ({isSyncEnabled:()=>true}));
    mock('server/sync/gateway/registry.ts', () => ({getActiveSyncGatewayAdapter:()=>adapter}));
    mock('server/utils/sync/rate-limiter.ts', () => ({checkSyncRateLimit:()=>({allowed:true}),recordSyncRequest:()=>{},getSyncRateLimitStats:()=>null}));
    mock('server/utils/rate-limit/enforce.ts', () => ({enforceRateLimit:()=>{}}));
    mock('server/sync/observations.ts', () => ({observeSyncRequest:(_e:unknown,_u:unknown,_w:unknown,_k:unknown,run:()=>unknown)=>run()}));
    mock('server/utils/storage/file-kind-capability.ts', () => ({isGenericFileMetaPayload:()=>false,requireFileKindCapability:()=>{}}));
    mock('server/utils/sync/workspace-item-capability.ts', () => ({requireWorkspaceItemCapability:()=>{}}));
    const {default:handler} = await import(join(host,'server/api/sync/push.post.ts'));
    return toWebHandler(createApp().use(handler));
}
async function rows<T = Record<string, unknown>>(query: string, ...parameters: unknown[]): Promise<T[]> {
    return (d1 ? (await d1.database.prepare(query).bind(...parameters).all<T>()).results : getRawDb().prepare(query).all(...parameters)) as T[];
}
async function execute(query: string, ...parameters: unknown[]) {
    if (d1) await d1.database.prepare(query).bind(...parameters).run();
    else getRawDb().prepare(query).run(...parameters);
}
async function push(ops: PendingOp[], capable = true) {
    const batch = { scope, historyIncarnation: history, historyIncarnationCapability:'incarnation-v1', ops,
        ...(capable ? { storedRecordCapability: 'stored-record-v1' } : {}) } as PushBatch;
    if (!http) return adapter.push(event,batch);
    const response = await http(new Request('http://localhost/api/sync/push',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(batch)}));
    const body = await response.json();
    if (!response.ok) throw Object.assign(new Error(body.message || body.statusMessage),{statusCode:response.status,data:body.data});
    expect(response.status).toBe(200);
    return body as Awaited<ReturnType<SqliteSyncGatewayAdapter['push']>>;
}
afterEach(async () => { await destroySqliteDb(); d1?.close(); d1 = undefined; http = undefined; });
describe.each(['native', 'd1', ...(process.env.OR3_PROJECT_HOST_ROOT ? ['host-http'] : [])])('%s push stored-record containment', driver => {
    beforeEach(async () => {
        _resetForTest(); if (driver === 'd1') d1 = createD1TestDatabase();
        await runMigrations(await initializeSqliteDb(d1 ? { driver: 'd1', d1Database: d1.database } : { path: ':memory:' }));
        adapter = new SqliteSyncGatewayAdapter(); history = await readHistoryIncarnation();
        if (driver === 'host-http') http = await hostHttp();
    });
    it.each(['losing-put', 'losing-delete', 'replay', 'legacy-receipt', 'oversized', 'invalid-payload', 'invalid-revision', 'notification-owner', 'deleted-notification-owner'])('%s holds only the affected intent with exact durable originals', async kind => {
        const existing = op('bad', 10);
        const notification = kind.endsWith('notification-owner');
        if (notification) {
            existing.tableName = 'notifications';
            existing.payload = { id: 'bad', user_id: 'owner', type: 'info', title: 'notice', deleted: false, created_at: 1, updated_at: 1, clock: existing.stamp.clock, hlc: existing.stamp.hlc, op_id: existing.stamp.opId };
        }
        expect((await push([existing])).results[0]?.success).toBe(true);
        if (kind === 'deleted-notification-owner') {
            expect((await push([{ ...op('bad', 20), tableName: 'notifications', operation: 'delete', payload: undefined }])).results[0]?.success).toBe(true);
        }
        const nextVersion = kind === 'deleted-notification-owner' ? 3 : 2;
        const table = notification ? 's_notifications' : 's_kv';
        const badBytes = kind === 'oversized' ? JSON.stringify({ value: 'x'.repeat(400_000) }) : kind === 'invalid-payload' ? '{}' : '{';
        if (kind === 'legacy-receipt') await execute('UPDATE change_log SET payload_json=?,intent_fingerprint=NULL WHERE op_id=?', badBytes, existing.stamp.opId);
        else if (kind === 'invalid-revision') await execute(`UPDATE ${table} SET clock=-1 WHERE id='bad'`);
        else await execute(`UPDATE ${table} SET data_json=? WHERE id='bad'`, badBytes);
        const bad = ['replay', 'legacy-receipt'].includes(kind) ? existing : { ...op('bad'), tableName: existing.tableName,
            ...(kind === 'losing-delete' ? { operation: 'delete' as const, payload: undefined } : {}),
            ...(notification ? { payload: existing.payload } : {}) };
        if (notification) bad.payload = {...bad.payload as Record<string,unknown>,clock:bad.stamp.clock,hlc:bad.stamp.hlc,op_id:bad.stamp.opId};
        const originalIntent = JSON.parse(JSON.stringify(bad));
        const healthy = op('healthy');
        const response = await push([healthy, bad]);
        expect(response.results[0]).toMatchObject({ success: true, applied: true, serverVersion: nextVersion });
        expect(response.results[1]).toMatchObject({ success: false, errorCode: 'STORED_RECORD_UNAVAILABLE', evidenceRef: expect.any(String) });
        expect(response.results[1]).not.toHaveProperty('replayed');
        expect(response.results[1]).not.toHaveProperty('payload');
        expect(await rows('SELECT value FROM server_version_counter')).toEqual([{ value: nextVersion }]);
        expect(await rows("SELECT id FROM s_kv WHERE id='healthy'")).toEqual([{ id: 'healthy' }]);
        const reference = (response.results[1] as { evidenceRef: string }).evidenceRef;
        const evidence = await rows<{ payload_json: string; metadata_json: string }>('SELECT payload_json,metadata_json FROM sync_unavailable_records WHERE id=?', reference);
        expect(evidence).toHaveLength(1);
        if (kind !== 'invalid-revision') expect(evidence[0]!.payload_json).toBe(badBytes);
        const intents = await rows<{ payload_json: string; metadata_json: string }>("SELECT payload_json,metadata_json FROM sync_unavailable_records WHERE source='push'");
        expect(JSON.parse(intents[0]!.payload_json)).toEqual(originalIntent);
        expect(JSON.parse(intents[0]!.metadata_json)).toMatchObject({ evidenceRef: reference });
        const count = (await rows('SELECT id FROM sync_unavailable_records')).length;
        expect((await push([bad])).results[0]).toMatchObject({ success: false, evidenceRef: reference });
        expect((await rows('SELECT id FROM sync_unavailable_records')).length).toBe(count);
    });
    it.each(['put','delete'] as const)('settles a losing %s against a readable tombstone without parsing its obsolete payload', async operation => {
        const existing={...op('deleted',10),operation:'delete' as const,payload:undefined};
        await push([existing]); await execute("UPDATE s_kv SET data_json='{' WHERE id='deleted'");
        const losing={...op('deleted'),operation,...(operation === 'delete'?{payload:undefined}:{})};
        const response=await push([op('healthy'),losing]);
        expect(response.results[0]).toMatchObject({success:true});
        expect(response.results[1]).toMatchObject({success:true,applied:false,winner:{kind:'delete',revision:{opId:existing.stamp.opId}}});
        expect(response.results[1]!.payload).toBeUndefined();
    });
    it('holds a replay whose authoritative winner is missing instead of fabricating success', async () => {
        const write = op('lost-winner'); await push([write]);
        await execute("DELETE FROM s_kv WHERE id='lost-winner'");
        const response = await push([op('healthy'),write]);
        expect(response.results[0]).toMatchObject({success:true,serverVersion:2});
        expect(response.results[1]).toMatchObject({success:false,errorCode:'STORED_RECORD_UNAVAILABLE',error:'stored_winner_missing',evidenceRef:expect.any(String)});
        expect(await rows('SELECT value FROM server_version_counter')).toEqual([{value:2}]);
    });
    it.runIf(driver === 'd1')('holds a replay winner removed after D1 preflight while healthy siblings commit', async () => {
        const existing=op('vanished');await push([existing]);
        const batch=d1!.database.batch.bind(d1!.database);let interleave=true;
        const spy=vi.spyOn(d1!.database,'batch').mockImplementation(async statements=>{
            if(interleave){interleave=false;await execute("DELETE FROM s_kv WHERE id='vanished'");}
            return batch(statements);
        });
        try {
            const response=await push([op('healthy'),existing]);
            expect(response.results[0]).toMatchObject({success:true,serverVersion:2});
            expect(response.results[1]).toMatchObject({success:false,errorCode:'STORED_RECORD_UNAVAILABLE',error:'stored_winner_missing',evidenceRef:expect.any(String)});
            expect(await rows('SELECT value FROM server_version_counter')).toEqual([{value:2}]);
        } finally {spy.mockRestore();}
    });
    it.runIf(driver === 'd1')('contains notification ownership corruption when the D1 batch interleaves after preflight', async () => {
        const existing = op('notice',10); existing.tableName='notifications';
        existing.payload={...existing.payload as Record<string,unknown>,user_id:'owner',type:'info',title:'notice'};
        await push([existing]);
        const bad={...op('notice',20),tableName:'notifications',operation:'delete' as const,payload:undefined};
        const batch=d1!.database.batch.bind(d1!.database);let interleave=true;
        const spy=vi.spyOn(d1!.database,'batch').mockImplementation(async statements=>{
            if(interleave){interleave=false;await execute("UPDATE s_notifications SET data_json='{' WHERE id='notice'");}
            return batch(statements);
        });
        try {
            const response=await push([op('healthy'),bad]);
            expect(response.results[0]).toMatchObject({success:true,serverVersion:2});
            expect(response.results[1]).toMatchObject({success:false,errorCode:'STORED_RECORD_UNAVAILABLE',evidenceRef:expect.any(String)});
            expect(await rows("SELECT data_json,deleted FROM s_notifications WHERE id='notice'")).toEqual([{data_json:'{',deleted:0}]);
            expect(await rows('SELECT * FROM tombstones')).toEqual([]);
        } finally {spy.mockRestore();}
    });
    it('requires an explicit new capability before emitting an unknown result code', async () => {
        await push([op('bad', 10)]);
        await execute("UPDATE s_kv SET data_json='{' WHERE id='bad'");
        await expect(push([op('healthy'), op('bad')], false)).rejects.toMatchObject({ statusCode: 426,
            data: { code: 'OR3_SYNC_UPDATE_REQUIRED', requiredCapability: 'stored-record-v1' } });
        expect(await rows("SELECT id FROM s_kv WHERE id='healthy'")).toEqual([]);
    });
    it('fails the request on durable evidence storage failure instead of blaming content', async () => {
        await push([op('bad', 10)]);
        await execute("UPDATE s_kv SET data_json='{' WHERE id='bad'");
        await execute("CREATE TRIGGER evidence_fault BEFORE INSERT ON sync_unavailable_records BEGIN SELECT raise(ABORT,'evidence disk failure'); END");
        if (http) await expect(push([op('healthy'), op('bad')])).rejects.toMatchObject({statusCode:500});
        else await expect(push([op('healthy'), op('bad')])).rejects.toThrow('evidence disk failure');
        expect(await rows("SELECT id FROM s_kv WHERE id='healthy'")).toEqual([]);
    });
});
