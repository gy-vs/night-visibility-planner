import { useMemo, useRef, useState } from 'react';
import type { NightResult, Target } from '../types';
import type { BlockDraft } from '../plan';
import { fmtTime } from '../time';

export const TARGET_COLORS = ['#4fc3f7', '#ffb74d', '#aed581', '#f06292', '#ba68c8', '#fff176'];

const W = 1040;
const ML = 56;
const MR = 16;
const CHART_H = 260;
const MT = 18;
const LANE_H = 72;
const LANE_GAP = 12;
const ALT_MIN = -15;
const ALT_MAX = 90;
const SNAP_MS = 5 * 60_000;

interface Props {
  night: NightResult;
  targets: Target[];
  selectedTargetId: string | null;
  drafts: BlockDraft[];
  overlaps: Set<string>;
  visProblems: Map<string, string>;
  confirmedIds: Set<string>;
  selectedBlockId: string | null;
  timezone: string;
  onSelectBlock: (clientId: string | null) => void;
  onChangeBlock: (clientId: string, startUtc: number, endUtc: number) => void;
}

type DragState =
  | { kind: 'move'; clientId: string; grabOffset: number; origStart: number; origEnd: number }
  | { kind: 'resize-l' | 'resize-r'; clientId: string; origStart: number; origEnd: number };

export function Timeline(props: Props) {
  const { night, timezone } = props;
  const { start: t0, end: t1 } = night.scan;
  const svgRef = useRef<SVGSVGElement>(null);
  const [drag, setDrag] = useState<DragState | null>(null);

  const laneCount = 1;
  const height = MT + CHART_H + LANE_GAP + LANE_H * laneCount + 30;
  const laneY = MT + CHART_H + LANE_GAP;

  const x = (t: number) => ML + ((t - t0) / (t1 - t0)) * (W - ML - MR);
  const y = (alt: number) => MT + (1 - (alt - ALT_MIN) / (ALT_MAX - ALT_MIN)) * CHART_H;
  const timeAtX = (px: number) => t0 + ((px - ML) / (W - ML - MR)) * (t1 - t0);

  const colorOf = useMemo(() => {
    const m = new Map<string, string>();
    props.targets.forEach((t, i) => m.set(t.id, TARGET_COLORS[i % TARGET_COLORS.length]));
    return (id: string) => m.get(id) ?? '#9e9e9e';
  }, [props.targets]);

  function svgX(e: React.PointerEvent): number {
    const rect = svgRef.current!.getBoundingClientRect();
    return ((e.clientX - rect.left) / rect.width) * W;
  }

  function onPointerMove(e: React.PointerEvent) {
    if (!drag) return;
    const t = timeAtX(svgX(e));
    const snap = (v: number) => Math.round(v / SNAP_MS) * SNAP_MS;
    const clamp = (v: number) => Math.min(Math.max(v, t0), t1);
    if (drag.kind === 'move') {
      const dur = drag.origEnd - drag.origStart;
      let s = snap(t - drag.grabOffset);
      s = Math.min(Math.max(s, t0), t1 - dur);
      props.onChangeBlock(drag.clientId, s, s + dur);
    } else if (drag.kind === 'resize-l') {
      const s = Math.min(clamp(snap(t)), drag.origEnd - SNAP_MS);
      props.onChangeBlock(drag.clientId, s, drag.origEnd);
    } else {
      const en = Math.max(clamp(snap(t)), drag.origStart + SNAP_MS);
      props.onChangeBlock(drag.clientId, drag.origStart, en);
    }
  }

  function startDrag(e: React.PointerEvent, d: BlockDraft, kind: DragState['kind']) {
    e.stopPropagation();
    (e.target as Element).setPointerCapture(e.pointerId);
    props.onSelectBlock(d.clientId);
    if (kind === 'move') {
      const grabOffset = timeAtX(svgX(e)) - d.startUtc;
      setDrag({ kind, clientId: d.clientId, grabOffset, origStart: d.startUtc, origEnd: d.endUtc });
    } else {
      setDrag({ kind, clientId: d.clientId, origStart: d.startUtc, origEnd: d.endUtc });
    }
  }

  // Hour tick marks every 2 hours.
  const ticks: number[] = [];
  for (let t = t0; t <= t1 + 1; t += 2 * 3600_000) ticks.push(t);

  const selected = props.selectedTargetId
    ? night.targets.find((t) => t.id === props.selectedTargetId)
    : null;

  return (
    <svg
      ref={svgRef}
      viewBox={`0 0 ${W} ${height}`}
      className="timeline"
      onPointerMove={onPointerMove}
      onPointerUp={() => setDrag(null)}
      onPointerLeave={() => setDrag(null)}
      onPointerDown={() => props.onSelectBlock(null)}
    >
      {/* daylight background + night shading */}
      <rect x={ML} y={MT} width={W - ML - MR} height={CHART_H} fill="#23303f" />
      {night.sun.darkWindows.map((w, i) => (
        <rect key={i} x={x(w.start)} y={MT} width={x(w.end) - x(w.start)} height={CHART_H} fill="#101b2c" />
      ))}
      {/* sub-horizon band */}
      <rect x={ML} y={y(0)} width={W - ML - MR} height={y(ALT_MIN) - y(0)} fill="#000" opacity={0.35} />

      {/* grid */}
      {[0, 30, 60, 90].map((a) => (
        <g key={a}>
          <line x1={ML} x2={W - MR} y1={y(a)} y2={y(a)} stroke="#3a4a5e" strokeDasharray={a === 0 ? '' : '3 4'} />
          <text x={ML - 6} y={y(a) + 4} textAnchor="end" fontSize="11" fill="#8fa3bd">{a}°</text>
        </g>
      ))}
      {ticks.map((t) => (
        <g key={t}>
          <line x1={x(t)} x2={x(t)} y1={MT} y2={MT + CHART_H} stroke="#2c3a4d" />
          <text x={x(t)} y={MT + CHART_H + 14} textAnchor="middle" fontSize="11" fill="#8fa3bd">
            {fmtTime(timezone, t)}
          </text>
        </g>
      ))}

      {/* observable windows for the selected target */}
      {selected?.windows.map((w, i) => (
        <rect key={i} x={x(w.start)} y={MT} width={x(w.end) - x(w.start)} height={7} fill="#43a047" opacity={0.9} rx={2} />
      ))}

      {/* min-alt line of the selected target */}
      {selected && (
        <line
          x1={ML} x2={W - MR} y1={y(selected.minAlt)} y2={y(selected.minAlt)}
          stroke={colorOf(selected.id)} strokeDasharray="6 4" opacity={0.7}
        />
      )}

      {/* altitude curves */}
      {night.targets.map((tg) => (
        <polyline
          key={tg.id}
          fill="none"
          stroke={colorOf(tg.id)}
          strokeWidth={tg.id === props.selectedTargetId ? 2.5 : 1.4}
          opacity={tg.id === props.selectedTargetId ? 1 : 0.55}
          points={tg.samples.map((s) => `${x(s.t)},${y(s.alt)}`).join(' ')}
        />
      ))}

      {/* planning lane */}
      <text x={ML - 6} y={laneY + LANE_H / 2} textAnchor="end" fontSize="11" fill="#8fa3bd" dominantBaseline="middle">
        计划
      </text>
      <rect x={ML} y={laneY} width={W - ML - MR} height={LANE_H} fill="#182230" stroke="#2c3a4d" />
      {night.sun.darkWindows.map((w, i) => (
        <rect key={i} x={x(w.start)} y={laneY} width={x(w.end) - x(w.start)} height={LANE_H} fill="#101b2c" />
      ))}
      {ticks.map((t) => (
        <line key={t} x1={x(t)} x2={x(t)} y1={laneY} y2={laneY + LANE_H} stroke="#22303f" />
      ))}

      {props.drafts.map((d) => {
        const bx = x(d.startUtc);
        const bw = Math.max(3, x(d.endUtc) - bx);
        const isSaved = props.confirmedIds.has(d.clientId) && !props.overlaps.has(d.clientId);
        const conflict = props.overlaps.has(d.clientId) || props.visProblems.has(d.clientId);
        const sel = props.selectedBlockId === d.clientId;
        const fill = colorOf(d.targetId);
        return (
          <g key={d.clientId}>
            <rect
              x={bx} y={laneY + 8} width={bw} height={LANE_H - 16} rx={3}
              fill={fill}
              fillOpacity={conflict ? 0.25 : isSaved ? 0.55 : 0.35}
              stroke={conflict ? '#ef5350' : sel ? '#fff' : fill}
              strokeWidth={sel ? 2 : 1.5}
              strokeDasharray={props.confirmedIds.has(d.clientId) ? undefined : '5 3'}
              style={{ cursor: 'grab' }}
              onPointerDown={(e) => startDrag(e, d, 'move')}
            />
            <rect
              x={bx - 3} y={laneY + 8} width={7} height={LANE_H - 16}
              fill="transparent" style={{ cursor: 'ew-resize' }}
              onPointerDown={(e) => startDrag(e, d, 'resize-l')}
            />
            <rect
              x={bx + bw - 4} y={laneY + 8} width={7} height={LANE_H - 16}
              fill="transparent" style={{ cursor: 'ew-resize' }}
              onPointerDown={(e) => startDrag(e, d, 'resize-r')}
            />
            {bw > 60 && (
              <text x={bx + bw / 2} y={laneY + LANE_H / 2 + 4} textAnchor="middle" fontSize="11"
                fill="#e8eef6" pointerEvents="none">
                {fmtTime(timezone, d.startUtc)}–{fmtTime(timezone, d.endUtc)}
              </text>
            )}
          </g>
        );
      })}
    </svg>
  );
}
