/** Complete fixed-time wire records for tests whose subject is not payload admission. */
export function validSyncPayload<T>(table: string, pk: string, payload: T) {
    const base = { id:pk,deleted:false,created_at:1,updated_at:1,clock:1 };
    const defaults: Record<string,Record<string,unknown>> = {
        threads:{status:'ready',pinned:false}, messages:{thread_id:'thread',role:'user',index:0,order_key:'a0'},
        projects:{name:pk},posts:{title:'test',content:'',post_type:'doc'},file_meta:{hash:pk},kv:{name:pk},notifications:{type:'info',title:'test'},
    };
    return {...base,...defaults[table],...payload};
}
