import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, ApiError } from './api';
import type { NightResult, PlanState, Site, Target, Violation } from './types';
import {
  findOverlaps,
  isDirty,
  matchesSelection,
  newClientId,
  toDrafts,
  visibilityProblems,
  type BlockDraft,
} from './plan';
import { fmtDateTime, fmtTime, localDateString } from './time';
import { Timeline, TARGET_COLORS } from './components/Timeline';
import { NewSiteForm, NewTargetForm } from './components/Forms';

export default function App() {
  const [sites, setSites] = useState<Site[]>([]);
  const [targets, setTargets] = useState<Target[]>([]);
  const [siteId, setSiteId] = useState<string>(() => localStorage.getItem('siteId') ?? '');
  const [date, setDate] = useState<string>(() => localStorage.getItem('date') ?? '');
  const [selectedTargetId, setSelectedTargetId] = useState<string | null>(null);

  const [night, setNight] = useState<NightResult | null>(null);
  const [computing, setComputing] = useState(false);
  const [computeError, setComputeError] = useState('');

  const [confirmed, setConfirmed] = useState<PlanState | null>(null);
  const [drafts, setDrafts] = useState<BlockDraft[]>([]);
  const [stale, setStale] = useState<PlanState | null>(null);
  const [violations, setViolations] = useState<Violation[]>([]);
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [selectedBlockId, setSelectedBlockId] = useState<string | null>(null);

  const computeSeq = useRef(0);
  const planSeq = useRef(0);

  const site = sites.find((s) => s.id === siteId) ?? null;

  // ---- initial data ----
  useEffect(() => {
    api.get<{ sites: Site[] }>('/api/sites').then((r) => {
      setSites(r.sites);
      setSiteId((cur) => cur || r.sites[0]?.id || '');
    });
    api.get<{ targets: Target[] }>('/api/targets').then((r) => {
      setTargets(r.targets);
      setSelectedTargetId((cur) => cur ?? r.targets[0]?.id ?? null);
    });
  }, []);

  // Default the date to "today" at the chosen site.
  useEffect(() => {
    if (site && !date) setDate(localDateString(site.timezone));
  }, [site, date]);

  useEffect(() => {
    localStorage.setItem('siteId', siteId);
    if (date) localStorage.setItem('date', date);
  }, [siteId, date]);

  // ---- astronomy computation (guarded against late responses) ----
  const targetsKey = targets.map((t) => `${t.id}:${t.ra}:${t.dec}:${t.minAlt}`).join('|');
  useEffect(() => {
    if (!site || !date) return;
    const seq = ++computeSeq.current;
    const sel = {
      lat: site.lat, lon: site.lon, elevation: site.elevation,
      date, timezone: site.timezone,
    };
    const payload = { ...sel, targets: targets.map((t) => ({ id: t.id, ra: t.ra, dec: t.dec, minAlt: t.minAlt })) };
    setComputing(true);
    setComputeError('');
    const timer = setTimeout(() => {
      api.post<NightResult>('/api/compute/night', payload)
        .then((res) => {
          // Drop the response if a newer request was issued, or if the echoed
          // parameters no longer match what is currently selected.
          if (seq !== computeSeq.current) return;
          if (!matchesSelection(res, sel)) return;
          setNight(res);
          setComputing(false);
        })
        .catch((e) => {
          if (seq !== computeSeq.current) return;
          setComputeError(e.message);
          setComputing(false);
        });
    }, 250);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [site?.id, site?.lat, site?.lon, site?.elevation, site?.timezone, date, targetsKey]);

  // ---- plan loading ----
  useEffect(() => {
    if (!site || !date) return;
    const seq = ++planSeq.current;
    api.post<PlanState>('/api/plans/ensure', { siteId: site.id, date })
      .then((ps) => {
        if (seq !== planSeq.current) return;
        setConfirmed(ps);
        setDrafts(toDrafts(ps.blocks));
        setStale(null);
        setViolations([]);
        setSaveState('idle');
      })
      .catch(() => {});
  }, [site?.id, date]);

  // ---- derived state ----
  const dirty = confirmed ? isDirty(drafts, confirmed.blocks) : false;
  const overlaps = useMemo(() => findOverlaps(drafts), [drafts]);
  const visProblems = useMemo(() => visibilityProblems(drafts, night), [drafts, night]);
  const confirmedIds = useMemo(
    () => new Set((confirmed?.blocks ?? []).map((b) => b.id)),
    [confirmed],
  );
  const hasClientConflicts = overlaps.size > 0 || visProblems.size > 0;

  const changeBlock = useCallback((clientId: string, startUtc: number, endUtc: number) => {
    setDrafts((ds) => ds.map((d) => (d.clientId === clientId ? { ...d, startUtc, endUtc } : d)));
    setSaveState('idle');
  }, []);

  function addBlock() {
    if (!night || !selectedTargetId) return;
    const tg = night.targets.find((t) => t.id === selectedTargetId);
    const w = tg?.windows[0];
    if (!w) return;
    const dur = Math.min(60 * 60_000, w.end - w.start);
    const start = Math.round((w.start + (w.end - w.start - dur) / 2) / 60_000) * 60_000;
    const d: BlockDraft = {
      clientId: newClientId(),
      targetId: selectedTargetId,
      startUtc: start,
      endUtc: start + dur,
      note: '',
    };
    setDrafts((ds) => [...ds, d]);
    setSelectedBlockId(d.clientId);
    setSaveState('idle');
  }

  function removeSelectedBlock() {
    if (!selectedBlockId) return;
    setDrafts((ds) => ds.filter((d) => d.clientId !== selectedBlockId));
    setSelectedBlockId(null);
    setSaveState('idle');
  }

  async function save() {
    if (!confirmed) return;
    setSaveState('saving');
    setViolations([]);
    try {
      const res = await api.put<PlanState>(`/api/plans/${confirmed.plan.id}/blocks`, {
        baseVersion: confirmed.plan.version,
        blocks: drafts.map((d) => ({
          id: d.id,
          targetId: d.targetId,
          startUtc: Math.round(d.startUtc),
          endUtc: Math.round(d.endUtc),
          note: d.note,
        })),
      });
      setConfirmed(res);
      setDrafts(toDrafts(res.blocks));
      setStale(null);
      setSaveState('saved');
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) {
        setStale(e.body.current as PlanState);
        setSaveState('error');
      } else if (e instanceof ApiError && e.status === 422) {
        setViolations(e.body.violations ?? []);
        setSaveState('error');
      } else {
        setViolations([{ blockId: null, targetId: null, code: 'network', message: String(e) }]);
        setSaveState('error');
      }
    }
  }

  function reloadServerVersion() {
    if (!stale) return;
    setConfirmed(stale);
    setDrafts(toDrafts(stale.blocks));
    setStale(null);
    setViolations([]);
    setSaveState('idle');
  }

  const selectedTarget = targets.find((t) => t.id === selectedTargetId) ?? null;
  const selectedNightTarget = night?.targets.find((t) => t.id === selectedTargetId) ?? null;

  return (
    <div className="app">
      <header>
        <h1>观测夜排程工作台</h1>
        <div className="selectors">
          <label>
            站点
            <select value={siteId} onChange={(e) => setSiteId(e.target.value)}>
              {sites.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </label>
          <label>
            当地日期
            <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          </label>
          {site && <span className="muted">时区 {site.timezone} · {site.lat.toFixed(3)}°, {site.lon.toFixed(3)}° · {site.elevation} m</span>}
          <NewSiteForm onCreated={(s) => { setSites((ss) => [...ss, s]); setSiteId(s.id); }} />
        </div>
      </header>

      {stale && confirmed && (
        <div className="banner stale">
          ⚠ 保存被拒绝：服务器上的计划已是 <b>v{stale.plan.version}</b>（你基于 v{confirmed.plan.version}），
          他处已做了修改，你的修改<b>没有</b>写入。
          <button onClick={reloadServerVersion}>加载服务器最新版本（放弃本地未保存修改）</button>
        </div>
      )}
      {violations.length > 0 && (
        <div className="banner error">
          服务器校验未通过，未写入任何修改：
          <ul>{violations.map((v, i) => <li key={i}>{v.message}</li>)}</ul>
        </div>
      )}
      {computeError && <div className="banner error">夜间计算失败:{computeError}</div>}

      <main>
        <section className="left">
          <div className="panel">
            <h2>目标</h2>
            <ul className="targets">
              {targets.map((t, i) => (
                <li
                  key={t.id}
                  className={t.id === selectedTargetId ? 'selected' : ''}
                  onClick={() => setSelectedTargetId(t.id)}
                >
                  <span className="swatch" style={{ background: TARGET_COLORS[i % TARGET_COLORS.length] }} />
                  <b>{t.name}</b>
                  <span className="muted">RA {t.ra.toFixed(3)}h · Dec {t.dec.toFixed(2)}° · ≥{t.minAlt}°</span>
                </li>
              ))}
            </ul>
            <NewTargetForm onCreated={(t) => { setTargets((ts) => [...ts, t]); setSelectedTargetId(t.id); }} />
          </div>

          <div className="panel">
            <h2>计划状态</h2>
            {confirmed && (
              <div className="status">
                <div>服务器版本:<b>v{confirmed.plan.version}</b>(更新于 {fmtDateTime(site?.timezone ?? 'UTC', Date.parse(confirmed.plan.updatedAt))})</div>
                <div>
                  {dirty
                    ? <span className="tag unsaved">● 有未保存的修改</span>
                    : <span className="tag saved">✓ 与服务器一致</span>}
                  {saveState === 'saving' && <span className="tag">保存中…</span>}
                  {saveState === 'saved' && !dirty && <span className="tag saved">已保存</span>}
                </div>
              </div>
            )}
            <div className="actions">
              <button onClick={addBlock} disabled={!selectedNightTarget || selectedNightTarget.windows.length === 0}>
                为选中目标添加拍摄块
              </button>
              <button onClick={removeSelectedBlock} disabled={!selectedBlockId}>删除选中块</button>
              <button className="primary" onClick={save} disabled={!dirty || hasClientConflicts || saveState === 'saving'}>
                保存计划
              </button>
            </div>
            {hasClientConflicts && (
              <div className="conflicts">
                {[...overlaps].map((id) => <div key={id}>⚠ 块时间重叠</div>)}
                {[...visProblems.entries()].map(([id, msg]) => <div key={id}>⚠ {msg}</div>)}
              </div>
            )}
          </div>

          {night && (
            <div className="panel">
              <h2>本次计算依据(服务端回显)</h2>
              <div className="echo">
                <div>地点:{night.request.lat}°, {night.request.lon}° · 海拔 {night.request.elevation} m</div>
                <div>日期:{night.request.date}({night.request.timezone})</div>
                <div>太阳高度阈值:{night.request.sunLimit}° · 计算于 {new Date(night.computedAt).toLocaleTimeString()}</div>
                <div>目标数:{night.request.targets.length} · 夜晚最低太阳高度 {night.sun.minAltitude.toFixed(1)}°</div>
              </div>
            </div>
          )}
        </section>

        <section className="right">
          {computing && <div className="muted">计算中…</div>}
          {night && site && (
            <>
              <Timeline
                night={night}
                targets={targets}
                selectedTargetId={selectedTargetId}
                drafts={drafts}
                overlaps={overlaps}
                visProblems={visProblems}
                confirmedIds={confirmedIds}
                selectedBlockId={selectedBlockId}
                timezone={site.timezone}
                onSelectBlock={setSelectedBlockId}
                onChangeBlock={changeBlock}
              />
              <div className="legend">
                <span><i className="box dark" /> 天文夜(太阳 ≤ {night.sun.limit}°)</span>
                <span><i className="box win" /> 选中目标可观测窗口</span>
                <span><i className="box draft" /> 未保存</span>
                <span><i className="box conflict" /> 冲突/不可见</span>
                <span className="muted">时间轴为 {site.timezone} 本地时间;块按 UTC 存储,不随时区漂移</span>
              </div>
              {selectedNightTarget && (
                <div className="windows">
                  <b>{selectedTarget?.name}</b> 可观测窗口:
                  {selectedNightTarget.windows.length === 0 && <span className="muted"> 本夜无(最高 {selectedNightTarget.maxAltitude.toFixed(1)}°)</span>}
                  {selectedNightTarget.windows.map((w, i) => (
                    <span key={i} className="tag">{fmtTime(site.timezone, w.start)} – {fmtTime(site.timezone, w.end)}</span>
                  ))}
                </div>
              )}
            </>
          )}
        </section>
      </main>
    </div>
  );
}
