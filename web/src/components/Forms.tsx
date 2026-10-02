import { useState } from 'react';
import type { Site, Target } from '../types';
import { api } from '../api';

const TZ_SUGGESTIONS = [
  'Pacific/Honolulu', 'America/Santiago', 'Atlantic/Canary', 'Europe/London',
  'Asia/Shanghai', 'Australia/Sydney', 'UTC',
];

export function NewSiteForm(props: { onCreated: (s: Site) => void }) {
  const [open, setOpen] = useState(false);
  const [f, setF] = useState({ name: '', lat: '', lon: '', elevation: '0', timezone: 'UTC' });
  const [err, setErr] = useState('');
  if (!open) return <button className="link" onClick={() => setOpen(true)}>+ 新建站点</button>;
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setF({ ...f, [k]: e.target.value });
  async function submit() {
    setErr('');
    try {
      const { site } = await api.post<{ site: Site }>('/api/sites', {
        name: f.name,
        lat: Number(f.lat),
        lon: Number(f.lon),
        elevation: Number(f.elevation),
        timezone: f.timezone,
      });
      props.onCreated(site);
      setOpen(false);
    } catch (e: any) {
      setErr(e.body?.details?.[0]?.message ?? e.message);
    }
  }
  return (
    <div className="form">
      <input placeholder="名称" value={f.name} onChange={set('name')} />
      <input placeholder="纬度°" value={f.lat} onChange={set('lat')} />
      <input placeholder="经度°" value={f.lon} onChange={set('lon')} />
      <input placeholder="海拔 m" value={f.elevation} onChange={set('elevation')} />
      <input placeholder="IANA 时区" list="tz-list" value={f.timezone} onChange={set('timezone')} />
      <datalist id="tz-list">{TZ_SUGGESTIONS.map((t) => <option key={t} value={t} />)}</datalist>
      <button onClick={submit}>保存站点</button>
      <button className="link" onClick={() => setOpen(false)}>取消</button>
      {err && <div className="error">{err}</div>}
    </div>
  );
}

export function NewTargetForm(props: { onCreated: (t: Target) => void }) {
  const [open, setOpen] = useState(false);
  const [f, setF] = useState({ name: '', ra: '', dec: '', minAlt: '30' });
  const [err, setErr] = useState('');
  if (!open) return <button className="link" onClick={() => setOpen(true)}>+ 新建目标</button>;
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setF({ ...f, [k]: e.target.value });
  async function submit() {
    setErr('');
    try {
      const { target } = await api.post<{ target: Target }>('/api/targets', {
        name: f.name,
        ra: Number(f.ra),
        dec: Number(f.dec),
        minAlt: Number(f.minAlt),
      });
      props.onCreated(target);
      setOpen(false);
    } catch (e: any) {
      setErr(e.body?.details?.[0]?.message ?? e.message);
    }
  }
  return (
    <div className="form">
      <input placeholder="名称" value={f.name} onChange={set('name')} />
      <input placeholder="赤经 RA (小时)" value={f.ra} onChange={set('ra')} />
      <input placeholder="赤纬 Dec (度)" value={f.dec} onChange={set('dec')} />
      <input placeholder="最低高度°" value={f.minAlt} onChange={set('minAlt')} />
      <button onClick={submit}>保存目标</button>
      <button className="link" onClick={() => setOpen(false)}>取消</button>
      {err && <div className="error">{err}</div>}
    </div>
  );
}
