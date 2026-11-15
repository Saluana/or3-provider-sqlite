import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import type { H3Event } from 'h3';
import { initializeSqliteDb, destroySqliteDb, getRawDb, _resetForTest } from '../server/db/kysely';
import { runMigrations } from '../server/db/migrate';
import { createD1TestDatabase } from '../../../test/support/d1-test-database';
import { SqliteSyncGatewayAdapter } from '../server/sync/sqlite-sync-gateway-adapter';
import type { PendingOp } from '~~/shared/sync/types';
const scope = {workspaceId:'incarnation'};
const event = {context:{__or3_session_context_test:{user:{id:'owner'},workspace:{id:scope.workspaceId}}}} as unknown as H3Event;
const op = (pk:string):PendingOp => ({id:randomUUID(),tableName:'kv',pk,operation:'put',payload:{id:pk,name:pk,value:'ok',created_at:1,updated_at:1},stamp:{opId:randomUUID(),deviceId:'test',clock:1,hlc:'legacy:1'},createdAt:1,attempts:0,status:'pending'});
let d1:ReturnType<typeof createD1TestDatabase>|undefined;
let adapter:SqliteSyncGatewayAdapter;
let history:string;
let db:Awaited<ReturnType<typeof initializeSqliteDb>>;
async function rows<T=Record<string,unknown>>(query:string,parameters:unknown[]=[]):Promise<T[]> {
    return (d1
        ? (await d1.database.prepare(query).bind(...parameters).all<T>()).results ?? []
        : getRawDb().prepare(query).all(...parameters)) as T[];
}
async function execute(query:string,...parameters:unknown[]) {
    if(d1) await d1.database.prepare(query).bind(...parameters).run();
    else getRawDb().prepare(query).run(...parameters);
}
async function rotate(token=randomUUID()) {
    const { rotateSyncHistory } = await import('../server/sync/history-incarnation');
    await rotateSyncHistory(token);
    return token;
}
afterEach(async()=>{vi.restoreAllMocks();vi.useRealTimers();await destroySqliteDb();d1?.close();d1=undefined;});
describe.each(['native','d1'])('%s history incarnation',driver=>{
    beforeEach(async()=>{
        _resetForTest(); if(driver==='d1') d1=createD1TestDatabase();
        db=await initializeSqliteDb(d1?{driver:'d1',d1Database:d1.database}:{path:':memory:'});
        await runMigrations(db); adapter=new SqliteSyncGatewayAdapter();
        const tables=await rows<{name:string}>("SELECT name FROM sqlite_master WHERE name='sync_history'");
        history=tables.length?(await rows<{incarnation:string}>('SELECT incarnation FROM sync_history'))[0]!.incarnation:'pre-incarnation';
    });
    it.each([0,99,100,120])('fences old cursor %i before payload decoding even after catch-up',async(cursor)=>{
        await execute('INSERT INTO server_version_counter VALUES (?,105)',scope.workspaceId);
        await execute(`INSERT INTO change_log (id,workspace_id,server_version,table_name,pk,op,payload_json,clock,hlc,device_id,op_id,created_at) VALUES (?,?,81,'kv','poison','put','{',1,'legacy:1','test',?,1)`,randomUUID(),scope.workspaceId,randomUUID());
        {
            const page=await adapter.pull(event,{scope,limit:100,cursor,historyIncarnation:'discarded-history'});
            expect(page).toMatchObject({historyIncarnation:history,changes:[],unavailable:[],nextCursor:cursor,hasMore:false,requiresSnapshot:true,oldestRetainedVersion:81});
        }
        expect(await rows('SELECT * FROM sync_unavailable_records')).toEqual([]);
    });
    it.each(['replay','empty','invalid'])('rejects old %s batch before any settlement',async kind=>{
        const write=op('lost-ack');
        await adapter.push(event,{scope,historyIncarnation:history,ops:[write]});
        const before=await rows('SELECT * FROM change_log');
        const ops=kind==='replay'?[write]:kind==='empty'?[]:[{...op('bad'),tableName:'unknown'}];
        {
            await expect(adapter.push(event,{scope,historyIncarnation:'discarded-history',ops})).rejects.toMatchObject({statusCode:409,data:{code:'OR3_SYNC_HISTORY_CHANGED',historyIncarnation:history,requiresSnapshot:true}});
        }
        expect(await rows('SELECT * FROM change_log')).toEqual(before);
        expect(await rows('SELECT value FROM server_version_counter')).toEqual([{value:1}]);
    });
    it('rejects stale ACKs without inserting or refreshing device state',async()=>{
        await adapter.push(event,{scope,historyIncarnation:history,ops:[op('row')]});
        await expect(adapter.updateCursor(event,{scope,deviceId:'test',version:1,historyIncarnation:'discarded-history'})).rejects.toMatchObject({statusCode:409});
        expect(await rows('SELECT * FROM device_cursors')).toEqual([]);
        await adapter.updateCursor(event,{scope,deviceId:'test',version:1,historyIncarnation:history});
        await execute('UPDATE device_cursors SET updated_at=123');
        await expect(adapter.updateCursor(event,{scope,deviceId:'test',version:1,historyIncarnation:'discarded-history'})).rejects.toMatchObject({statusCode:409});
        expect(await rows('SELECT updated_at FROM device_cursors')).toEqual([{updated_at:123}]);
    });
    it('bootstraps unbound discovery and refuses missing required tokens',async()=>{
        const page=await adapter.snapshot(event,{scope,pageSize:1,historyIncarnation:null});
        expect(page).toMatchObject({historyIncarnation:history,highWatermark:0,items:[]});
        expect(await adapter.pull(event,{scope,limit:100,cursor:0,historyIncarnation:null})).toMatchObject({historyIncarnation:history,requiresSnapshot:true,nextCursor:0});
        await expect(adapter.push(event,{scope,ops:[],historyIncarnationCapability:'incarnation-v1'})).rejects.toMatchObject({statusCode:400});
        await expect(adapter.pull(event,{scope,limit:100,cursor:0,historyIncarnationCapability:'incarnation-v1'})).rejects.toMatchObject({statusCode:400});
        await expect(adapter.snapshot(event,{scope,pageSize:1,historyIncarnationCapability:'incarnation-v1'})).rejects.toMatchObject({statusCode:400});
    });
    it('gives a legacy host an explicit update boundary before history dispatch',async()=>{
        const required={statusCode:426,data:{code:'OR3_SYNC_UPDATE_REQUIRED',requiredCapability:'incarnation-v1'}};
        await expect(adapter.pull(event,{scope,cursor:0,limit:100})).rejects.toMatchObject(required);
        await expect(adapter.snapshot(event,{scope,pageSize:1})).rejects.toMatchObject(required);
        await expect(adapter.push(event,{scope,ops:[op('legacy')]})).rejects.toMatchObject(required);
        await expect(adapter.updateCursor(event,{scope,deviceId:'legacy',version:0})).rejects.toMatchObject(required);
        for(const table of ['sync_snapshots','sync_snapshot_items','device_cursors','change_log','server_version_counter']) {
            expect(await rows(`SELECT * FROM ${table}`)).toEqual([]);
        }
        expect(await adapter.getHistoryIncarnation(event,scope)).toBe(history);
    });
    it.each(['request','token'])('rejects stale snapshot %s before serving an archived session',async stale=>{
        await adapter.push(event,{scope,historyIncarnation:history,ops:[op('a'),op('b')]});
        const first=await adapter.snapshot(event,{scope,historyIncarnation:history,pageSize:1});
        const token=JSON.parse(Buffer.from(first.nextPageToken!,'base64url').toString('utf8')) as Record<string,unknown>;
        if(stale==='token') token.historyIncarnation='discarded-history';
        await expect(adapter.snapshot(event,{scope,pageSize:1,
            historyIncarnation:stale==='request'?'discarded-history':history,
            pageToken:Buffer.from(JSON.stringify(token)).toString('base64url')})).rejects.toMatchObject({statusCode:409});
        expect(await rows('SELECT id FROM sync_snapshots')).toEqual([{id:first.snapshotId}]);
    });
    it('binds internal archive discovery and continuations without requiring browser request fields',async()=>{
        await adapter.push(event,{scope,historyIncarnation:history,ops:[op('a'),op('b')]});
        // The workspace export route supplies no browser history fields.
        const first=await adapter.backupSnapshot(event,{scope,pageSize:1,tables:['kv']});
        expect(first).toMatchObject({historyIncarnation:history,highWatermark:2,items:[{pk:'a'}]});
        expect(first.nextPageToken).toBeTruthy();
        const last=await adapter.backupSnapshot(event,{scope,pageSize:1,tables:['kv'],pageToken:first.nextPageToken!});
        expect(last).toMatchObject({historyIncarnation:history,snapshotId:first.snapshotId,highWatermark:2,items:[{pk:'b'}],nextPageToken:null});
        // Internal discovery must not weaken the browser snapshot requirement.
        await expect(adapter.snapshot(event,{scope,pageSize:1,historyIncarnationCapability:'incarnation-v1'})).rejects.toMatchObject({statusCode:400});
        const legacy=JSON.parse(Buffer.from(first.nextPageToken!,'base64url').toString('utf8'));
        delete legacy.historyIncarnation;
        await expect(adapter.backupSnapshot(event,{scope,pageSize:1,pageToken:Buffer.from(JSON.stringify(legacy)).toString('base64url')})).rejects.toMatchObject({statusCode:409});
        const next=await rotate();
        await expect(adapter.backupSnapshot(event,{scope,pageSize:1,pageToken:first.nextPageToken!})).rejects.toMatchObject({statusCode:409,data:{historyIncarnation:next}});
        await expect(adapter.backupSnapshot(event,{scope,pageSize:1,historyIncarnation:history})).rejects.toMatchObject({statusCode:409});
        expect(await rows('SELECT * FROM sync_snapshots')).toEqual([]);
    });
    it('atomically resets sessions/ACKs, preserves history/evidence and rejects pre-reset tokens',async()=>{
        await adapter.push(event,{scope,historyIncarnation:history,ops:[op('a'),op('b')]});
        await execute("UPDATE s_kv SET data_json='{' WHERE id='a'");
        const first=await adapter.snapshot(event,{scope,pageSize:1,historyIncarnation:history});
        const evidence=await rows('SELECT * FROM sync_unavailable_records'); expect(evidence).toHaveLength(1);
        await adapter.updateCursor(event,{scope,deviceId:'test',version:2,historyIncarnation:history});
        const before=await rows('SELECT * FROM change_log');
        const next=await rotate(); expect(next).not.toBe(history);
        expect(await rows('SELECT * FROM sync_snapshots')).toEqual([]);
        expect(await rows('SELECT * FROM sync_snapshot_items')).toEqual([]);
        expect(await rows('SELECT * FROM device_cursors')).toEqual([]);
        expect(await rows('SELECT * FROM sync_unavailable_records')).toEqual(evidence);
        expect(await rows('SELECT * FROM change_log')).toEqual(before);
        expect(await rows('SELECT value FROM server_version_counter')).toEqual([{value:2}]);
        for(const expected of [history,next]) await expect(adapter.snapshot(event,{scope,pageSize:1,pageToken:first.nextPageToken!,historyIncarnation:expected})).rejects.toMatchObject({statusCode:409});
        const fresh=await adapter.snapshot(event,{scope,pageSize:1,historyIncarnation:next});
        expect(fresh.historyIncarnation).toBe(next);
        expect(await rows('SELECT * FROM sync_unavailable_records')).toHaveLength(2);
        await runMigrations(db); await adapter.gcChangeLog(event,{scope,retentionSeconds:3600});
        expect(await adapter.getHistoryIncarnation(event,scope)).toBe(next);
        await rotate(next); // journal reconciliation of the same stopped candidate
        expect(await adapter.getHistoryIncarnation(event,scope)).toBe(next);
        expect(await rotate()).not.toBe(next);
    });
    it('rolls back an interrupted reset and reconciles the same stopped candidate',async()=>{
        await adapter.push(event,{scope,historyIncarnation:history,ops:[op('a'),op('b')]});
        const page=await adapter.snapshot(event,{scope,historyIncarnation:history,pageSize:1});
        await adapter.updateCursor(event,{scope,deviceId:'test',version:2,historyIncarnation:history});
        await execute("CREATE TRIGGER reset_fault BEFORE DELETE ON device_cursors BEGIN SELECT raise(ABORT,'reset fault'); END");
        const next=randomUUID();
        await expect(rotate(next)).rejects.toThrow('reset fault');
        expect(await adapter.getHistoryIncarnation(event,scope)).toBe(history);
        expect(await rows('SELECT id FROM sync_snapshots')).toEqual([{id:page.snapshotId}]);
        expect(await rows('SELECT * FROM sync_snapshot_items')).toHaveLength(2);
        expect(await rows('SELECT * FROM device_cursors')).toHaveLength(1);
        await execute('DROP TRIGGER reset_fault');
        await rotate(next); await rotate(next);
        expect(await adapter.getHistoryIncarnation(event,scope)).toBe(next);
        expect(await rows('SELECT * FROM device_cursors')).toEqual([]);
    });
    it('resumes initial migration atomically and preserves a committed singleton on ledger retry',async()=>{
        await execute("DELETE FROM kysely_migration WHERE name='036_sync_history_incarnation'");
        await execute('DROP TABLE sync_history');
        await execute("INSERT INTO sync_snapshots VALUES ('pre-contract',?,1,'[]',1,9999999999)",scope.workspaceId);
        await execute("INSERT INTO device_cursors (id,workspace_id,device_id,owner_user_id,last_seen_version,updated_at) VALUES ('old',?,'test','owner',100,1)",scope.workspaceId);
        await execute("CREATE TRIGGER reset_fault BEFORE DELETE ON device_cursors BEGIN SELECT raise(ABORT,'reset fault'); END");
        await expect(runMigrations(db)).rejects.toThrow('reset fault');
        expect(await rows('SELECT id FROM sync_snapshots')).toEqual([{id:'pre-contract'}]);
        expect(await rows('SELECT * FROM device_cursors')).toHaveLength(1);
        expect(await rows("SELECT name FROM kysely_migration WHERE name='036_sync_history_incarnation'")).toEqual([]);
        await execute('DROP TRIGGER reset_fault');
        await runMigrations(db);
        const committed=await adapter.getHistoryIncarnation(event,scope);
        expect(committed).toMatch(/^[0-9a-f-]{36}$/);
        expect(await rows('SELECT * FROM sync_snapshots')).toEqual([]);
        expect(await rows('SELECT * FROM device_cursors')).toEqual([]);
        // Crash after D1 initialization commit but before the migration ledger.
        await execute("DELETE FROM kysely_migration WHERE name='036_sync_history_incarnation'");
        const fresh=await adapter.snapshot(event,{scope,pageSize:1,historyIncarnation:committed});
        await runMigrations(db);
        expect(await adapter.getHistoryIncarnation(event,scope)).toBe(committed);
        expect(await rows('SELECT id FROM sync_snapshots')).toEqual([{id:fresh.snapshotId}]);
    });
    it('never repairs or settles old-history evidence even when the canonical revision is restored unchanged',async()=>{
        await adapter.push(event,{scope,historyIncarnation:history,ops:[op('a')]});
        await execute("UPDATE s_kv SET data_json='{' WHERE id='a'");
        const page=await adapter.snapshot(event,{scope,pageSize:1,historyIncarnation:history});
        const id=page.unavailable![0]!.evidenceRef;
        const next=await rotate();
        for(const expected of [history,next]) await expect(adapter.maintainUnavailableRecords(event,scope.workspaceId,'repair',{
            historyIncarnation:expected,id,payload:op('a').payload})).rejects.toMatchObject({statusCode:409});
        expect(await rows('SELECT status FROM sync_unavailable_records WHERE id=?',[id])).toEqual([{status:'unresolved'}]);
        expect(await rows('SELECT value FROM server_version_counter')).toEqual([{value:1}]);
    });
    it('expires same-history sessions with 410 and closes a watcher when incarnation changes at an equal head',async()=>{
        await adapter.push(event,{scope,historyIncarnation:history,ops:[op('a'),op('b')]});
        const page=await adapter.snapshot(event,{scope,historyIncarnation:history,pageSize:1});
        await execute('DELETE FROM sync_snapshots');
        await expect(adapter.snapshot(event,{scope,pageSize:1,historyIncarnation:history,pageToken:page.nextPageToken!})).rejects.toMatchObject({statusCode:410});
        vi.useFakeTimers(); const notify=vi.fn(); const fail=vi.fn();
        const stop=await adapter.watchVersion(event,scope,notify,fail);
        try {
            await vi.advanceTimersByTimeAsync(0);
            expect(notify).toHaveBeenLastCalledWith({historyIncarnation:history,version:2});
            const next=await rotate();
            await vi.advanceTimersByTimeAsync(2000);
            expect(fail).toHaveBeenCalledWith(expect.objectContaining({data:expect.objectContaining({historyIncarnation:next})}));
            expect(notify).toHaveBeenCalledTimes(1);
            await vi.advanceTimersByTimeAsync(4000);
            expect(fail).toHaveBeenCalledTimes(1);
        } finally { stop(); }
    });
    it.runIf(driver==='d1')('rechecks the D1 batch before replay and ACK mutation after an awaited preflight',async()=>{
        const write=op('a');await adapter.push(event,{scope,historyIncarnation:history,ops:[write]});
        const batch=d1!.database.batch.bind(d1!.database);
        let next=randomUUID();
        const spy=vi.spyOn(d1!.database,'batch').mockImplementation(async statements=>{
            await execute('UPDATE sync_history SET incarnation=?',next);
            return batch(statements);
        });
        try {
            await expect(adapter.push(event,{scope,historyIncarnation:history,ops:[write]})).rejects.toMatchObject({statusCode:409});
            history=next; next=randomUUID();
            await expect(adapter.updateCursor(event,{scope,deviceId:'test',version:1,historyIncarnation:history})).rejects.toMatchObject({statusCode:409});
            expect(await rows('SELECT * FROM device_cursors')).toEqual([]);
            expect(await rows('SELECT value FROM server_version_counter')).toEqual([{value:1}]);
        } finally {spy.mockRestore();}
    });
    it.each(['', 'x'.repeat(129), 'non-ascii-界'])('fails closed on a malformed persisted singleton (%s)',async invalid=>{
        await execute('UPDATE sync_history SET incarnation=?',invalid);
        await expect(runMigrations(db)).rejects.toThrow('Invalid sync history singleton');
        await expect(adapter.getHistoryIncarnation(event,scope)).rejects.toThrow('Invalid sync history singleton');
        expect(await rows('SELECT incarnation FROM sync_history')).toEqual([{incarnation:invalid}]);
    });
    it.runIf(driver==='native' && !!process.env.OR3_PROJECT_HOST_ROOT)('rotates actual stopped candidate bytes through H5 target-image helper',async()=>{
        await adapter.push(event,{scope,historyIncarnation:history,ops:[op('a'),op('b')]});
        await execute("UPDATE s_kv SET data_json='{' WHERE id='a'");
        const page=await adapter.snapshot(event,{scope,pageSize:1,historyIncarnation:history});
        await adapter.updateCursor(event,{scope,deviceId:'test',version:2,historyIncarnation:history});
        const directory=await mkdtemp(join(tmpdir(),'s3-offline-'));
        const path=join(directory,'candidate.sqlite');
        try {
            await execute('VACUUM INTO ?',path);
            const names=(await rows<{name:string}>('SELECT name FROM kysely_migration ORDER BY name')).map(row=>row.name);
            const helper=await import(pathToFileURL(join(process.env.OR3_PROJECT_HOST_ROOT!,'scripts/docker/sync-history-reset.mjs')).href) as {
                resetHistory(DatabaseCtor:typeof Database,path:string,incarnation:string,migrations:string[]):{historyIncarnation:string};
            };
            const next=randomUUID();
            expect(helper.resetHistory(Database,path,next,names)).toMatchObject({historyIncarnation:next});
            const copy=new Database(path);
            try {
                expect(copy.prepare('SELECT incarnation FROM sync_history').get()).toEqual({incarnation:next});
                for(const table of ['sync_snapshots','sync_snapshot_items','device_cursors']) expect(copy.prepare(`SELECT count(*) AS n FROM ${table}`).get()).toEqual({n:0});
                expect(copy.prepare('SELECT count(*) AS n FROM sync_unavailable_records').get()).toEqual({n:1});
                expect(copy.prepare('SELECT value FROM server_version_counter').get()).toEqual({value:2});
                expect(copy.prepare('SELECT count(*) AS n FROM change_log').get()).toEqual({n:2});
            } finally {copy.close();}
            // Restoring the same archive again needs a distinct journaled UUID.
            const again=randomUUID();
            expect(helper.resetHistory(Database,path,again,names).historyIncarnation).toBe(again);
            expect(again).not.toBe(next);
            expect(await rows('SELECT id FROM sync_snapshots')).toEqual([{id:page.snapshotId}]);
            expect(await adapter.getHistoryIncarnation(event,scope)).toBe(history);
        } finally {await rm(directory,{recursive:true,force:true});}
    });
    it('fails closed on invalid singleton rather than initializing at startup',async()=>{
        await execute('DELETE FROM sync_history');
        await expect(runMigrations(db)).rejects.toThrow();
        await expect(adapter.getHistoryIncarnation(event,scope)).rejects.toThrow();
        expect(await rows('SELECT * FROM sync_history')).toEqual([]);
    });
});
