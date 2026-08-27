import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router";
import { Download, RefreshCw, Search, Trash2 } from "lucide-react";
import { Button } from "#/ui/button";
import { Input } from "#/ui/input";
import { Checkbox } from "#/ui/checkbox";
import { Typography } from "#/ui/typography";
import AgentServerConversationService from "#/api/conversation-service/agent-server-conversation-service.api";
import AgentServerRuntimeService from "#/api/runtime-service/agent-server-runtime-service";
import type { AppConversation } from "#/api/conversation-service/agent-server-conversation-service.types";

const tokens = (c: AppConversation) => c.metrics?.accumulated_token_usage;
const formatNumber = (n: number) => new Intl.NumberFormat("ru-RU").format(n);
// Small dependency-free ZIP writer. Files are already compressed by the server
// (trajectory JSON and tar.gz workspace), so STORE avoids double compression.
function crc32(data: Uint8Array) { let c=~0; for (const b of data) { c^=b; for(let k=0;k<8;k++) c=(c>>>1)^((c&1)?0xedb88320:0); } return (~c)>>>0; }
function zip(files: {name:string; data:Uint8Array}[]) {
  const enc=new TextEncoder(), chunks:Uint8Array[]=[]; const central:Uint8Array[]=[]; let offset=0;
  const u32=(n:number)=>{const a=new Uint8Array(4);new DataView(a.buffer).setUint32(0,n,true);return a}; const u16=(n:number)=>{const a=new Uint8Array(2);new DataView(a.buffer).setUint16(0,n,true);return a};
  for(const f of files){const name=enc.encode(f.name), head=new Uint8Array([...new Uint8Array([80,75,3,4]),...u16(20),...u16(0),...u16(0),...u16(0),...u16(0),...u32(crc32(f.data)),...u32(f.data.length),...u32(f.data.length),...u16(name.length),...u16(0),...name]);chunks.push(head,f.data);central.push(new Uint8Array([...new Uint8Array([80,75,1,2]),...u16(20),...u16(20),...u16(0),...u16(0),...u16(0),...u16(0),...u32(crc32(f.data)),...u32(f.data.length),...u32(f.data.length),...u16(name.length),...u16(0),...u16(0),...u16(0),...u16(0),...u32(0),...u32(offset),...name]));offset+=head.length+f.data.length;}
  const start=offset; chunks.push(...central); const size=central.reduce((n,x)=>n+x.length,0); chunks.push(new Uint8Array([...new Uint8Array([80,75,5,6]),...u16(0),...u16(0),...u16(files.length),...u16(files.length),...u32(size),...u32(start),...u16(0)])); return new Blob(chunks,{type:"application/zip"});
}

export default function ConversationManagement() {
  const [items, setItems] = useState<AppConversation[]>([]);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try { setItems((await AgentServerConversationService.searchConversations(100)).items); }
    catch (e) { setError(e instanceof Error ? e.message : "Не удалось загрузить диалоги"); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const filtered = useMemo(() => items.filter(c => {
    const text = `${c.title ?? ""} ${c.id} ${c.selected_repository ?? ""}`.toLowerCase();
    return text.includes(query.toLowerCase());
  }), [items, query]);
  const totalIn = items.reduce((s,c) => s + (tokens(c)?.prompt_tokens ?? 0), 0);
  const totalOut = items.reduce((s,c) => s + (tokens(c)?.completion_tokens ?? 0), 0);
  const toggleAll = () => setSelected(selected.size === filtered.length ? new Set() : new Set(filtered.map(c => c.id)));
  const toggle = (id: string) => setSelected(prev => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const remove = async () => {
    if (!selected.size || !confirm(`Удалить диалогов: ${selected.size}? Это действие нельзя отменить.`)) return;
    setWorking(true);
    try { await Promise.all([...selected].map(id => AgentServerConversationService.deleteConversation(id))); setSelected(new Set()); await load(); }
    catch (e) { setError(e instanceof Error ? e.message : "Не удалось удалить выбранные диалоги"); }
    finally { setWorking(false); }
  };
  const exportList = async () => {
    const chosen = filtered.filter(c => selected.has(c.id) || !selected.size); if (!chosen.length) return;
    setWorking(true); setError(null);
    try {
      const files: {name:string;data:Uint8Array}[] = [{name:"manifest.json", data:new TextEncoder().encode(JSON.stringify({exported_at:new Date().toISOString(), conversations:chosen.map(c=>({id:c.id,title:c.title,metrics:c.metrics}))},null,2))}];
      for (const c of chosen) {
        const trajectory = await AgentServerConversationService.downloadConversation(c.id);
        files.push({name:`conversations/${c.id}/trajectory.json`,data:new Uint8Array(await trajectory.arrayBuffer())});
        if (c.workspace?.working_dir) { const archive=await AgentServerRuntimeService.downloadWorkspaceArchive(c.conversation_url,c.session_api_key,c.workspace.working_dir); files.push({name:`conversations/${c.id}/workspace.tar.gz`,data:new Uint8Array(await archive.blob.arrayBuffer())}); }
      }
      const blob=zip(files); const a=document.createElement("a"); a.href=URL.createObjectURL(blob); a.download=`agenthaus-export-${new Date().toISOString().slice(0,10)}.zip`; a.click(); URL.revokeObjectURL(a.href);
    } catch(e) { setError(e instanceof Error ? e.message : "Не удалось экспортировать диалоги"); } finally { setWorking(false); }
  };
  return <div className="mx-auto flex max-w-6xl flex-col gap-6 px-4 pb-10">
    <div><Typography.H2>Управление диалогами</Typography.H2><p className="mt-1 text-sm text-tertiary-light">Поиск, контроль токенов и безопасная очистка истории.</p></div>
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-3"><Stat label="Диалогов" value={formatNumber(items.length)} /><Stat label="Входные токены" value={formatNumber(totalIn)} /><Stat label="Выходные токены" value={formatNumber(totalOut)} /></div>
    <div className="flex flex-wrap items-center gap-3"><div className="relative min-w-[260px] flex-1"><Search className="absolute left-3 top-2.5 size-4 text-tertiary-light" /><Input className="pl-9" placeholder="Название, репозиторий или ID" value={query} onChange={e=>setQuery(e.target.value)} /></div><Button variant="outline" onClick={()=>void load()} disabled={loading}><RefreshCw className="mr-2 size-4"/>Обновить</Button><Button variant="outline" onClick={exportList} disabled={!filtered.length}><Download className="mr-2 size-4"/>Экспорт{selected.size ? ` (${selected.size})` : ""}</Button><Button variant="destructive" onClick={()=>void remove()} disabled={!selected.size || working}><Trash2 className="mr-2 size-4"/>Удалить</Button></div>
    {error && <div className="rounded-lg border border-danger-light bg-danger-light/10 p-3 text-sm text-danger-light">{error}</div>}
    <div className="overflow-hidden rounded-xl border border-light"><div className="flex items-center gap-3 border-b border-light px-4 py-3 text-sm"><Checkbox checked={filtered.length > 0 && selected.size === filtered.length} onCheckedChange={toggleAll} aria-label="Выбрать все"/><span>{selected.size ? `Выбрано: ${selected.size}` : `Показано: ${filtered.length}`}</span></div>{loading ? <div className="p-8 text-center text-sm text-tertiary-light">Загрузка…</div> : filtered.length ? filtered.map(c => <div key={c.id} className="flex items-center gap-3 border-b border-light px-4 py-3 last:border-0"><Checkbox checked={selected.has(c.id)} onCheckedChange={()=>toggle(c.id)} aria-label={`Выбрать ${c.title ?? c.id}`}/><div className="min-w-0 flex-1"><Link className="font-medium hover:underline" to={`/conversations/${c.id}`}>{c.title || "Без названия"}</Link><div className="truncate text-xs text-tertiary-light">{c.selected_repository || c.id} · {new Date(c.updated_at).toLocaleString("ru-RU")}</div></div><div className="hidden text-right text-xs text-tertiary-light sm:block"><div>↑ {formatNumber(tokens(c)?.prompt_tokens ?? 0)}</div><div>↓ {formatNumber(tokens(c)?.completion_tokens ?? 0)}</div></div></div>) : <div className="p-10 text-center text-sm text-tertiary-light">Диалоги не найдены</div>}</div>
    <p className="text-xs text-tertiary-light">Подробные события диалога не загружаются этой страницей. Токены берутся из агрегированных метрик бэкенда, поэтому база не разрастается от аналитики.</p>
  </div>;
}
function Stat({label,value}:{label:string;value:string}) { return <div className="rounded-xl border border-light bg-transparent p-4"><div className="text-xs text-tertiary-light">{label}</div><div className="mt-1 text-xl font-semibold">{value}</div></div>; }
