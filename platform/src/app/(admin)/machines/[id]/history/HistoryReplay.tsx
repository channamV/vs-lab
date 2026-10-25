"use client";

import "leaflet/dist/leaflet.css";
import type * as Leaflet from "leaflet";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { formatMinutes, indexAt, replayTimeline, replayToReal, stopEngineLabel, type Stop, type TrackPoint } from "@/lib/history-track";
import { WORKSITE_TYPES, worksiteColor, type WorksiteType } from "@/lib/worksite-types";

type Site = { id: number; name: string; type: string; polygon: [number, number][] };
type Shift = { name: string; from: number; to: number };

/** Replay speeds: real seconds per replay second. */
const SPEEDS = [
  [60, "1 min/s"],
  [300, "5 min/s"],
  [1800, "30 min/s"],
  [7200, "2 h/s"],
] as const;

const TRACK = "#2a78d6";
const START = "#16a34a";
const END = "#dc2626";

/** Builds a small popup from text lines (never HTML: operator and site names are typed by users). */
function popup(lines: string[], strong?: string) {
  const div = document.createElement("div");
  div.style.fontSize = "12px";
  if (strong) {
    const b = document.createElement("div");
    b.style.fontWeight = "600";
    b.textContent = strong;
    div.append(b);
  }
  for (const line of lines) {
    const p = document.createElement("div");
    p.textContent = line;
    div.append(p);
  }
  return div;
}

const arrow = (L: typeof Leaflet, heading: number | null) =>
  L.divIcon({
    className: "",
    iconSize: [26, 26],
    iconAnchor: [13, 13],
    html: `<div style="width:26px;height:26px;transform:rotate(${heading ?? 0}deg)"><svg viewBox="0 0 26 26" width="26" height="26"><circle cx="13" cy="13" r="11" fill="${TRACK}" stroke="white" stroke-width="2"/><path d="M13 5 L18 16 L13 13.5 L8 16 Z" fill="white"/></svg></div>`,
  });

/**
 * Location history for one machine: the track (broken where the device went quiet and the machine reappeared
 * elsewhere), start/end, stops, worksites, and a replay with a moving arrow (docs/location-history.md).
 */
export function HistoryReplay({
  points,
  segmentStarts,
  stops,
  operators,
  sites,
  timeZone,
}: {
  points: TrackPoint[];
  segmentStarts: number[];
  stops: Stop[];
  operators: Shift[];
  sites: Site[];
  timeZone: string;
}) {
  const box = useRef<HTMLDivElement>(null);
  const L = useRef<typeof Leaflet | null>(null);
  const map = useRef<Leaflet.Map | null>(null);
  const layers = useRef<{ sites: Leaflet.LayerGroup; base: Leaflet.LayerGroup; played: Leaflet.Polyline[]; marker: Leaflet.Marker | null; stops: Leaflet.CircleMarker[] } | null>(
    null,
  );
  const [ready, setReady] = useState(false);
  const [showSites, setShowSites] = useState(true);
  const [skipQuiet, setSkipQuiet] = useState(true);
  const [speed, setSpeed] = useState<number>(300);
  const [follow, setFollow] = useState(true);
  const [playing, setPlaying] = useState(false);
  /** Replay position (ms of replay time); null = not replaying, the whole track is shown. */
  const [pos, setPos] = useState<number | null>(null);

  const timeline = useMemo(() => replayTimeline(points, skipQuiet), [points, skipQuiet]);
  const length = timeline.at(-1) ?? 0;
  const segments = useMemo(() => {
    const starts = [0, ...segmentStarts, points.length];
    return starts.slice(0, -1).map((s, i) => ({ start: s, end: starts[i + 1] }));
  }, [points.length, segmentStarts]);

  const time = useMemo(() => new Intl.DateTimeFormat("en-CA", { timeZone, month: "short", day: "numeric", hour: "numeric", minute: "2-digit", second: "2-digit" }), [timeZone]);
  const shortTime = useMemo(() => new Intl.DateTimeFormat("en-CA", { timeZone, month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }), [timeZone]);
  const operatorAt = useCallback((t: number) => operators.find((o) => o.from <= t && t <= o.to)?.name ?? null, [operators]);
  const describe = useCallback(
    (p: TrackPoint) => [
      p.kph === null ? "Speed unknown" : `${Math.round(p.kph)} km/h${p.heading !== null && (p.kph ?? 0) >= 3 ? ` heading ${p.heading}°` : ""}`,
      p.engineOn === null ? "Engine: unknown" : p.engineOn ? "Engine running" : "Engine off",
      `Operator: ${operatorAt(p.t) ?? "nobody checked in"}`,
    ],
    [operatorAt],
  );

  // Map, once.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const leaflet = await import("leaflet");
      if (cancelled || !box.current || map.current) return;
      L.current = leaflet;
      const m = leaflet.map(box.current, { scrollWheelZoom: false }).setView([45, -75], 4);
      leaflet.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19, attribution: "&copy; OpenStreetMap contributors" }).addTo(m);
      layers.current = { sites: leaflet.layerGroup().addTo(m), base: leaflet.layerGroup().addTo(m), played: [], marker: null, stops: [] };
      map.current = m;
      setReady(true);
    })();
    return () => {
      cancelled = true;
      map.current?.remove();
      map.current = null;
    };
  }, []);

  // Worksites.
  useEffect(() => {
    const leaflet = L.current;
    const g = layers.current?.sites;
    if (!ready || !leaflet || !g) return;
    g.clearLayers();
    if (!showSites) return;
    for (const site of sites) {
      leaflet
        .polygon(site.polygon, { color: worksiteColor(site.type), weight: 1.5, fillOpacity: 0.12 })
        .bindTooltip(`${site.name} · ${WORKSITE_TYPES[site.type as WorksiteType]?.label ?? site.type}`, { sticky: true })
        .addTo(g);
    }
  }, [ready, showSites, sites]);

  // Track, start/end, stops (redrawn when the data changes).
  useEffect(() => {
    const leaflet = L.current;
    const m = map.current;
    const lay = layers.current;
    if (!ready || !leaflet || !m || !lay) return;
    lay.base.clearLayers();
    lay.played = [];
    lay.stops = [];
    lay.marker = null;
    if (!points.length) return;
    const nearest = (ll: Leaflet.LatLng) => {
      let best = 0;
      let bestD = Infinity;
      points.forEach((p, i) => {
        const d = (p.lat - ll.lat) ** 2 + (p.lng - ll.lng) ** 2;
        if (d < bestD) [best, bestD] = [i, d];
      });
      return points[best];
    };
    for (const seg of segments) {
      const line = points.slice(seg.start, seg.end).map((p) => [p.lat, p.lng] as [number, number]);
      // The faint full track (seen ahead of the replay), and the played part on top.
      leaflet.polyline(line, { color: TRACK, weight: 4, opacity: 0.25 }).addTo(lay.base);
      const played = leaflet.polyline(line, { color: TRACK, weight: 4, opacity: 0.9 }).addTo(lay.base);
      played.on("click", (e: Leaflet.LeafletMouseEvent) => {
        const p = nearest(e.latlng);
        leaflet.popup().setLatLng([p.lat, p.lng]).setContent(popup(describe(p), time.format(new Date(p.t)))).openOn(m);
      });
      lay.played.push(played);
    }
    for (const s of stops) {
      const c = leaflet
        .circleMarker([s.lat, s.lng], { radius: Math.min(12, 5 + Math.sqrt(s.minutes) / 2), color: "#ffffff", weight: 2, fillColor: "#334155", fillOpacity: 1 })
        .bindPopup(
          popup(
            [`${shortTime.format(new Date(s.start))} – ${shortTime.format(new Date(s.end))}`, stopEngineLabel(s)],
            `Stopped ${formatMinutes(s.minutes)}`,
          ),
        )
        .addTo(lay.base);
      lay.stops.push(c);
    }
    const first = points[0];
    const last = points.at(-1)!;
    leaflet.circleMarker([first.lat, first.lng], { radius: 7, color: "#ffffff", weight: 2, fillColor: START, fillOpacity: 1 }).bindTooltip(`Start · ${shortTime.format(new Date(first.t))}`).addTo(lay.base);
    leaflet.circleMarker([last.lat, last.lng], { radius: 7, color: "#ffffff", weight: 2, fillColor: END, fillOpacity: 1 }).bindTooltip(`End · ${shortTime.format(new Date(last.t))}`).addTo(lay.base);
    m.fitBounds(points.map((p) => [p.lat, p.lng] as [number, number]), { padding: [30, 30], maxZoom: 16 });
  }, [ready, points, segments, stops, describe, time, shortTime]);

  // Where the replay is: the real time, the point index and an interpolated position.
  const current = useMemo(() => {
    if (pos === null || !points.length) return null;
    const t = replayToReal(points, timeline, pos);
    const i = Math.max(0, indexAt(points, t));
    const a = points[i];
    const b = points[i + 1];
    const sameSegment = b && !segmentStarts.includes(i + 1);
    const f = sameSegment && b.t > a.t ? (t - a.t) / (b.t - a.t) : 0;
    return { t, i, lat: a.lat + (sameSegment ? (b.lat - a.lat) * f : 0), lng: a.lng + (sameSegment ? (b.lng - a.lng) * f : 0), point: a };
  }, [pos, points, timeline, segmentStarts]);

  // Draw the replay: played part of each segment + the arrow.
  useEffect(() => {
    const leaflet = L.current;
    const m = map.current;
    const lay = layers.current;
    if (!ready || !leaflet || !m || !lay || !points.length) return;
    segments.forEach((seg, k) => {
      const line = lay.played[k];
      if (!line) return;
      let slice: [number, number][];
      if (!current || current.i >= seg.end - 1) slice = points.slice(seg.start, seg.end).map((p) => [p.lat, p.lng]);
      else if (current.i < seg.start) slice = [];
      else slice = [...points.slice(seg.start, current.i + 1).map((p) => [p.lat, p.lng] as [number, number]), [current.lat, current.lng]];
      line.setLatLngs(slice);
    });
    if (!current) {
      lay.marker?.remove();
      lay.marker = null;
      return;
    }
    if (!lay.marker) lay.marker = leaflet.marker([current.lat, current.lng], { icon: arrow(leaflet, current.point.heading), interactive: false }).addTo(lay.base);
    else {
      lay.marker.setLatLng([current.lat, current.lng]);
      lay.marker.setIcon(arrow(leaflet, current.point.heading));
    }
    if (follow && !m.getBounds().pad(-0.25).contains([current.lat, current.lng])) m.panTo([current.lat, current.lng], { animate: false });
  }, [ready, current, points, segments, follow]);

  // Playback loop. posRef mirrors pos so the animation frame reads the latest value without re-subscribing.
  const posRef = useRef<number | null>(pos);
  useEffect(() => {
    posRef.current = pos;
  }, [pos]);
  useEffect(() => {
    if (!playing) return;
    let frame = 0;
    let last = performance.now();
    const tick = (now: number) => {
      const next = Math.min(length, (posRef.current ?? 0) + (now - last) * speed);
      last = now;
      posRef.current = next;
      setPos(next);
      if (next >= length) setPlaying(false);
      else frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [playing, speed, length]);

  // Keep the replay at the same real time when "skip quiet periods" changes the timeline.
  const toggleSkip = (on: boolean) => {
    const t = current?.t ?? null;
    setSkipQuiet(on);
    if (t !== null) {
      const tl = replayTimeline(points, on);
      const i = Math.max(0, indexAt(points, t));
      const next = points[i + 1];
      const f = next && next.t > points[i].t ? (t - points[i].t) / (next.t - points[i].t) : 0;
      setPos(tl[i] + (next ? (tl[i + 1] - tl[i]) * f : 0));
    }
  };

  const playFrom = (t: number) => {
    const i = Math.max(0, indexAt(points, t));
    setPos(timeline[i]);
    setPlaying(true);
    box.current?.scrollIntoView({ behavior: "smooth", block: "center" });
  };

  if (!points.length) {
    return <p className="rounded-lg border border-dashed border-slate-300 p-6 text-sm text-slate-500 dark:border-slate-700">No positions in this period.</p>;
  }

  const btn = "rounded border border-slate-300 px-3 py-1 text-sm hover:bg-slate-50 dark:border-slate-700 dark:hover:bg-slate-800";
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2 rounded-lg border border-slate-200 bg-white p-3 text-sm dark:border-slate-800 dark:bg-slate-900">
        <button
          type="button"
          className="rounded bg-sky-700 px-3 py-1 font-medium text-white hover:bg-sky-800"
          onClick={() => {
            if (playing) setPlaying(false);
            else {
              if (pos === null || pos >= length) setPos(0);
              setPlaying(true);
            }
          }}
        >
          {playing ? "Pause" : pos === null ? "▶ Replay" : pos >= length ? "▶ Replay again" : "▶ Play"}
        </button>
        {pos !== null && (
          <button
            type="button"
            className={btn}
            onClick={() => {
              setPlaying(false);
              setPos(null);
            }}
          >
            Show whole track
          </button>
        )}
        <label className="flex items-center gap-1">
          Speed
          <select value={speed} onChange={(e) => setSpeed(Number(e.target.value))} className="rounded border border-slate-300 bg-transparent px-1 py-0.5 dark:border-slate-700">
            {SPEEDS.map(([v, label]) => (
              <option key={v} value={v}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-1">
          <input type="checkbox" checked={skipQuiet} onChange={(e) => toggleSkip(e.target.checked)} /> Skip parked time
        </label>
        <label className="flex items-center gap-1">
          <input type="checkbox" checked={follow} onChange={(e) => setFollow(e.target.checked)} /> Follow machine
        </label>
        {sites.length > 0 && (
          <label className="flex items-center gap-1">
            <input type="checkbox" checked={showSites} onChange={(e) => setShowSites(e.target.checked)} /> Worksites
          </label>
        )}
        <input
          type="range"
          min={0}
          max={1000}
          value={pos === null || !length ? 1000 : Math.round((pos / length) * 1000)}
          onChange={(e) => {
            setPlaying(false);
            setPos((Number(e.target.value) / 1000) * length);
          }}
          aria-label="Replay position"
          className="min-w-40 flex-1"
        />
      </div>
      {current && (
        <div className="flex flex-wrap gap-x-6 gap-y-1 rounded-lg bg-slate-100 px-3 py-2 text-sm tabular-nums dark:bg-slate-800">
          <span className="font-semibold">{time.format(new Date(current.t))}</span>
          {describe(current.point).map((line) => (
            <span key={line}>{line}</span>
          ))}
        </div>
      )}
      <div ref={box} style={{ height: 520 }} className="z-0 w-full overflow-hidden rounded-lg border border-slate-200 dark:border-slate-800" />
      <p className="text-xs text-slate-500">
        <span style={{ color: START }}>●</span> Start · <span style={{ color: END }}>●</span> End · <span className="text-slate-700 dark:text-slate-300">●</span> Stop (5 min or
        more). Click the track for the time, speed and operator at that spot. Gaps in the line: the device was silent and the machine turned up elsewhere.
      </p>
      {stops.length > 0 && (
        <section className="rounded-lg border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
          <h2 className="mb-2 font-semibold">Stops ({stops.length})</h2>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-left text-slate-500">
                <tr>
                  <th className="py-1 pr-3 font-normal">From</th>
                  <th className="py-1 pr-3 font-normal">To</th>
                  <th className="py-1 pr-3 font-normal">Duration</th>
                  <th className="py-1 pr-3 font-normal">Engine</th>
                  <th className="py-1 pr-3 font-normal">Operator</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {stops.map((s, i) => (
                  <tr key={s.start} className="border-t border-slate-100 dark:border-slate-800">
                    <td className="py-1.5 pr-3 whitespace-nowrap">{shortTime.format(new Date(s.start))}</td>
                    <td className="py-1.5 pr-3 whitespace-nowrap">{shortTime.format(new Date(s.end))}</td>
                    <td className="py-1.5 pr-3">{formatMinutes(s.minutes)}</td>
                    <td className="py-1.5 pr-3">{stopEngineLabel(s)}</td>
                    <td className="py-1.5 pr-3">{operatorAt(s.start) ?? "—"}</td>
                    <td className="py-1.5 whitespace-nowrap text-right">
                      <button
                        type="button"
                        className="mr-3 text-sky-700 hover:underline dark:text-sky-400"
                        onClick={() => {
                          map.current?.setView([s.lat, s.lng], Math.max(map.current.getZoom(), 16));
                          layers.current?.stops[i]?.openPopup();
                          box.current?.scrollIntoView({ behavior: "smooth", block: "center" });
                        }}
                      >
                        Show
                      </button>
                      <button type="button" className="text-sky-700 hover:underline dark:text-sky-400" onClick={() => playFrom(s.start)}>
                        Replay from here
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </div>
  );
}
