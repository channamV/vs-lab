"use client";

import "leaflet/dist/leaflet.css";
import type * as Leaflet from "leaflet";
import Link from "next/link";
import { useActionState, useEffect, useRef, useState, useTransition } from "react";
import { formatHours, machineLabel, timeAgo } from "@/lib/format";
import { checkPolygon, WORKSITE_TYPES, worksiteColor, type Polygon, type WorksiteType } from "@/lib/worksite-types";
import { deleteWorksiteAction, savePerimeterAction, saveWorksiteAction, type WorksiteFormState } from "./actions";

/**
 * The Worksites page: a map to draw and edit worksite boundaries (modelled on Veristart Insights), with
 * the list underneath. Drawing: click to add corners, double-click (or Finish) to close the shape.
 * Editing a shape: drag the corners, click a small midpoint dot to add a corner, right-click (or press
 * and hold) a corner to remove it.
 */

export type SiteRow = {
  id: number;
  name: string;
  type: string;
  notes: string | null;
  polygon: Polygon;
  dwellLimitMinutes: number | null;
  speedLimitKph: number | null;
  machinesInside: { id: number; name: string; unitNumber: string | null; since: Date }[];
};
type MachinePoint = { id: number; name: string; unitNumber: string | null; lat: number | null; lng: number | null; lastSeenAt: Date | null };

type Mode =
  | { kind: "view" }
  | { kind: "draw"; points: Polygon }
  | { kind: "details"; id: number | null; polygon: Polygon | null }
  | { kind: "shape"; id: number; points: Polygon };

const button = "rounded border border-slate-300 px-3 py-1.5 text-sm hover:bg-slate-50 dark:border-slate-700 dark:hover:bg-slate-800";
const primary = "rounded bg-sky-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-sky-800 disabled:opacity-50";
const field = "mt-1 w-full rounded border border-slate-300 bg-transparent px-2 py-1.5 dark:border-slate-700";
const card = "rounded-lg border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900";

const handleIcon = (L: typeof Leaflet, color: string, size: number) =>
  L.divIcon({
    className: "",
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2],
    html: `<div style="width:${size}px;height:${size}px;border-radius:9999px;background:${color};border:2px solid white;box-shadow:0 0 2px rgba(0,0,0,.6)"></div>`,
  });

export function WorksiteManager({ sites, machines, canEdit }: { sites: SiteRow[]; machines: MachinePoint[]; canEdit: boolean }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<Leaflet.Map | null>(null);
  const leafletRef = useRef<typeof Leaflet | null>(null);
  const layers = useRef<{ sites: Leaflet.LayerGroup; machines: Leaflet.LayerGroup; edit: Leaflet.LayerGroup } | null>(null);
  const [ready, setReady] = useState(false);
  const [mode, setMode] = useState<Mode>({ kind: "view" });
  const modeRef = useRef(mode);
  modeRef.current = mode;
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [typeFilter, setTypeFilter] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const shown = sites.filter((s) => !typeFilter || s.type === typeFilter);
  const selected = sites.find((s) => s.id === selectedId) ?? null;

  // Create the map once.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const L = await import("leaflet");
      if (cancelled || !containerRef.current || mapRef.current) return;
      const map = L.map(containerRef.current, { scrollWheelZoom: true }).setView([43.7, -79.4], 9);
      L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19, attribution: "&copy; OpenStreetMap contributors" }).addTo(map);
      leafletRef.current = L;
      mapRef.current = map;
      layers.current = { sites: L.layerGroup().addTo(map), machines: L.layerGroup().addTo(map), edit: L.layerGroup().addTo(map) };
      const all = [...sites.flatMap((s) => s.polygon), ...machines.filter((m) => m.lat !== null).map((m) => [m.lat!, m.lng!] as [number, number])];
      if (all.length) map.fitBounds(all, { padding: [40, 40], maxZoom: 15 });
      setReady(true);
    })();
    return () => {
      cancelled = true;
    };
    // Fit to the data only on first load; later changes keep the user's view.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(
    () => () => {
      mapRef.current?.remove();
      mapRef.current = null;
    },
    [],
  );

  // Worksite outlines.
  useEffect(() => {
    const L = leafletRef.current;
    if (!ready || !L || !layers.current) return;
    const layer = layers.current.sites;
    layer.clearLayers();
    for (const site of shown) {
      if (mode.kind === "shape" && mode.id === site.id) continue;
      const isSelected = site.id === selectedId;
      L.polygon(site.polygon, {
        color: worksiteColor(site.type),
        weight: isSelected ? 3 : 2,
        fillOpacity: isSelected ? 0.35 : 0.15,
      })
        .bindTooltip(`${site.name} · ${WORKSITE_TYPES[site.type as WorksiteType]?.label ?? site.type}`, { sticky: true })
        .on("click", () => {
          if (modeRef.current.kind === "view") setSelectedId(site.id);
        })
        .addTo(layer);
    }
  }, [ready, shown, selectedId, mode]);

  // Machines, for reference.
  useEffect(() => {
    const L = leafletRef.current;
    if (!ready || !L || !layers.current) return;
    const layer = layers.current.machines;
    layer.clearLayers();
    for (const m of machines) {
      if (m.lat === null || m.lng === null) continue;
      L.circleMarker([m.lat, m.lng], { radius: 6, color: "#ffffff", weight: 2, fillColor: "#0ea5e9", fillOpacity: 1, interactive: true })
        .bindTooltip(`${machineLabel(m)} · last seen ${timeAgo(m.lastSeenAt)}`)
        .addTo(layer);
    }
  }, [ready, machines]);

  // Drawing a new boundary: clicks add corners, double-click finishes.
  useEffect(() => {
    const map = mapRef.current;
    if (!ready || !map || mode.kind !== "draw") return;
    map.doubleClickZoom.disable();
    const container = map.getContainer();
    container.style.cursor = "crosshair";
    const addPoint = (e: Leaflet.LeafletMouseEvent) => {
      setMode((m) => {
        if (m.kind !== "draw") return m;
        const last = m.points.at(-1);
        const point: [number, number] = [e.latlng.lat, e.latlng.lng];
        // A double-click also sends two clicks at the same spot: don't add those twice.
        if (last && map.latLngToContainerPoint(last).distanceTo(map.latLngToContainerPoint(point)) < 4) return m;
        return { ...m, points: [...m.points, point] };
      });
    };
    const finish = () => finishDrawing();
    map.on("click", addPoint);
    map.on("dblclick", finish);
    return () => {
      map.off("click", addPoint);
      map.off("dblclick", finish);
      map.doubleClickZoom.enable();
      container.style.cursor = "";
    };
  }, [ready, mode.kind]);

  // What's being drawn or edited.
  useEffect(() => {
    const L = leafletRef.current;
    if (!ready || !L || !layers.current) return;
    const layer = layers.current.edit;
    layer.clearLayers();
    if (mode.kind === "draw" && mode.points.length) {
      L.polyline(mode.points, { color: "#f59e0b", weight: 2, dashArray: "5,5" }).addTo(layer);
      for (const p of mode.points) L.circleMarker(p, { radius: 4, color: "#f59e0b", fillOpacity: 1, interactive: false }).addTo(layer);
    }
    if (mode.kind === "details" && mode.polygon) {
      L.polygon(mode.polygon, { color: "#f59e0b", weight: 2, dashArray: "5,5", fillOpacity: 0.2 }).addTo(layer);
    }
    if (mode.kind === "shape") {
      const site = sites.find((s) => s.id === mode.id);
      const color = worksiteColor(site?.type ?? "other");
      const outline = L.polygon(mode.points, { color, weight: 2, fillOpacity: 0.2, interactive: false }).addTo(layer);
      const live = mode.points.map((p) => [...p] as [number, number]);
      live.forEach((p, i) => {
        L.marker(p, { draggable: true, icon: handleIcon(L, "#ea580c", 14), title: "Drag to move; right-click or hold to remove" })
          .on("drag", (e) => {
            const ll = (e.target as Leaflet.Marker).getLatLng();
            live[i] = [ll.lat, ll.lng];
            outline.setLatLngs(live);
          })
          .on("dragend", () => setMode((m) => (m.kind === "shape" ? { ...m, points: live.map((q) => [...q] as [number, number]) } : m)))
          .on("contextmenu", () =>
            setMode((m) => (m.kind === "shape" && m.points.length > 3 ? { ...m, points: m.points.filter((_, j) => j !== i) } : m)),
          )
          .addTo(layer);
      });
      mode.points.forEach((p, i) => {
        const q = mode.points[(i + 1) % mode.points.length];
        const mid: [number, number] = [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2];
        L.marker(mid, { icon: handleIcon(L, "#fdba74", 10), title: "Click to add a corner here" })
          .on("click", () =>
            setMode((m) => (m.kind === "shape" ? { ...m, points: [...m.points.slice(0, i + 1), mid, ...m.points.slice(i + 1)] } : m)),
          )
          .addTo(layer);
      });
    }
  }, [ready, mode, sites]);

  // Escape cancels drawing or shape editing.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && (modeRef.current.kind === "draw" || modeRef.current.kind === "shape")) setMode({ kind: "view" });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  function finishDrawing() {
    const m = modeRef.current;
    if (m.kind !== "draw") return;
    const checked = checkPolygon(m.points);
    if (!checked.ok) {
      setMessage(checked.error);
      return;
    }
    setMessage(null);
    setMode({ kind: "details", id: null, polygon: checked.polygon });
  }

  function focusSite(site: SiteRow) {
    setSelectedId(site.id);
    mapRef.current?.flyToBounds(site.polygon, { padding: [60, 60], maxZoom: 17 });
  }

  function saveShape() {
    if (mode.kind !== "shape") return;
    const { id, points } = mode;
    startTransition(async () => {
      const result = await savePerimeterAction(id, points);
      if (result.error) setMessage(result.error);
      else {
        setMessage(null);
        setMode({ kind: "view" });
      }
    });
  }

  function remove(site: SiteRow) {
    if (!window.confirm(`Delete "${site.name}"? Its visit history goes too. This can't be undone.`)) return;
    startTransition(async () => {
      const result = await deleteWorksiteAction(site.id);
      setMessage(result.error);
      if (!result.error && selectedId === site.id) setSelectedId(null);
    });
  }

  const editing = mode.kind !== "view";

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <PlaceSearch onPick={(bounds) => mapRef.current?.fitBounds(bounds, { maxZoom: 17 })} />
        <select
          value={typeFilter}
          onChange={(e) => setTypeFilter(e.target.value)}
          aria-label="Filter by type"
          className="rounded border border-slate-300 bg-transparent px-2 py-1.5 text-sm dark:border-slate-700"
        >
          <option value="">All types</option>
          {Object.entries(WORKSITE_TYPES).map(([key, t]) => (
            <option key={key} value={key}>
              {t.label}
            </option>
          ))}
        </select>
        {canEdit && !editing && (
          <button
            className={`${primary} ml-auto`}
            onClick={() => {
              setSelectedId(null);
              setMessage(null);
              setMode({ kind: "draw", points: [] });
            }}
          >
            + New worksite
          </button>
        )}
      </div>

      {mode.kind === "draw" && (
        <Banner>
          <span>
            Click the map to add corners; double-click (or <strong>Finish</strong>) to close the shape.{" "}
            {mode.points.length > 0 && <span className="text-slate-500">{mode.points.length} corners.</span>}
          </span>
          <span className="ml-auto flex gap-2">
            <button className={button} disabled={mode.points.length === 0} onClick={() => setMode({ ...mode, points: mode.points.slice(0, -1) })}>
              Undo corner
            </button>
            <button className={button} onClick={() => setMode({ kind: "view" })}>
              Cancel
            </button>
            <button className={primary} disabled={mode.points.length < 3} onClick={finishDrawing}>
              Finish
            </button>
          </span>
        </Banner>
      )}
      {mode.kind === "shape" && (
        <Banner>
          <span>
            Editing the boundary of <strong>{sites.find((s) => s.id === mode.id)?.name}</strong>: drag the corners, click a small dot to add a
            corner, right-click (or press and hold) a corner to remove it.
          </span>
          <span className="ml-auto flex gap-2">
            <button className={button} onClick={() => setMode({ kind: "view" })}>
              Cancel
            </button>
            <button className={primary} disabled={pending} onClick={saveShape}>
              {pending ? "Saving…" : "Save boundary"}
            </button>
          </span>
        </Banner>
      )}
      {message && <p className="text-sm text-red-600">{message}</p>}

      <div className="grid gap-4 lg:grid-cols-[1fr_20rem]">
        <div>
          <div ref={containerRef} className="z-0 h-[520px] w-full overflow-hidden rounded-lg border border-slate-200 dark:border-slate-800" />
          <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-500">
            {Object.entries(WORKSITE_TYPES).map(([key, t]) => (
              <span key={key} className="flex items-center gap-1">
                <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: t.color }} />
                {t.label}
              </span>
            ))}
            <span className="flex items-center gap-1">
              <span className="inline-block h-2.5 w-2.5 rounded-full border border-white bg-sky-500" />
              Machines ({machines.filter((m) => m.lat !== null).length})
            </span>
          </div>
        </div>

        <aside className="space-y-3">
          {mode.kind === "details" ? (
            <DetailsForm
              key={mode.id ?? "new"}
              site={mode.id ? (sites.find((s) => s.id === mode.id) ?? null) : null}
              polygon={mode.polygon}
              onCancel={() => setMode({ kind: "view" })}
              onSaved={(id) => {
                setMode({ kind: "view" });
                setSelectedId(id);
              }}
            />
          ) : selected ? (
            <div className={`${card} space-y-3 p-4`}>
              <div>
                <h2 className="flex items-center gap-2 font-semibold">
                  <span className="inline-block h-3 w-3 rounded-full" style={{ background: worksiteColor(selected.type) }} />
                  {selected.name}
                </h2>
                <p className="text-sm text-slate-500">{WORKSITE_TYPES[selected.type as WorksiteType]?.label ?? selected.type}</p>
              </div>
              {selected.notes && <p className="text-sm">{selected.notes}</p>}
              <p className="text-sm">
                {selected.dwellLimitMinutes
                  ? `Notify after a machine has been here ${formatHours(selected.dwellLimitMinutes / 60)}.`
                  : "No time limit."}
                {selected.speedLimitKph ? ` Speed limit ${Math.round(selected.speedLimitKph)} km/h.` : ""}
              </p>
              <div>
                <h3 className="text-sm font-medium">Here now ({selected.machinesInside.length})</h3>
                <ul className="text-sm">
                  {selected.machinesInside.map((m) => (
                    <li key={m.id}>
                      <Link href={`/machines/${m.id}`} className="text-sky-700 hover:underline dark:text-sky-400">
                        {machineLabel(m)}
                      </Link>{" "}
                      <span className="text-slate-500">since {timeAgo(m.since)}</span>
                    </li>
                  ))}
                </ul>
              </div>
              {canEdit && !editing && (
                <div className="flex flex-wrap gap-2 pt-1">
                  <button className={button} onClick={() => setMode({ kind: "details", id: selected.id, polygon: null })}>
                    Edit details
                  </button>
                  <button
                    className={button}
                    onClick={() => {
                      focusSite(selected);
                      setMode({ kind: "shape", id: selected.id, points: selected.polygon });
                    }}
                  >
                    Edit boundary
                  </button>
                  <button className={`${button} text-red-700 dark:text-red-400`} disabled={pending} onClick={() => remove(selected)}>
                    Delete
                  </button>
                </div>
              )}
            </div>
          ) : (
            <div className={`${card} p-4 text-sm text-slate-600 dark:text-slate-400`}>
              {sites.length === 0
                ? canEdit
                  ? "No worksites yet. Click “+ New worksite”, then click around the area on the map."
                  : "No worksites yet. A manager can draw them."
                : "Select a worksite on the map or in the list."}
            </div>
          )}
        </aside>
      </div>

      <div className={`${card} overflow-x-auto`}>
        <table className="w-full text-left text-sm">
          <thead className="border-b border-slate-200 text-xs uppercase text-slate-500 dark:border-slate-800">
            <tr>
              <th className="px-4 py-2">Worksite</th>
              <th className="px-4 py-2">Type</th>
              <th className="px-4 py-2">Machines here now</th>
              <th className="px-4 py-2">Time limit</th>
              <th className="px-4 py-2">Notes</th>
            </tr>
          </thead>
          <tbody>
            {shown.length === 0 && (
              <tr>
                <td colSpan={5} className="px-4 py-3 text-slate-500">
                  No worksites{typeFilter ? " of this type" : ""}.
                </td>
              </tr>
            )}
            {shown.map((site) => (
              <tr
                key={site.id}
                onClick={() => !editing && focusSite(site)}
                className={`cursor-pointer border-b border-slate-100 last:border-0 hover:bg-slate-50 dark:border-slate-800 dark:hover:bg-slate-800/50 ${
                  site.id === selectedId ? "bg-sky-50 dark:bg-sky-950/40" : ""
                }`}
              >
                <td className="px-4 py-2 font-medium">
                  <span className="mr-2 inline-block h-2.5 w-2.5 rounded-full" style={{ background: worksiteColor(site.type) }} />
                  {site.name}
                </td>
                <td className="px-4 py-2">{WORKSITE_TYPES[site.type as WorksiteType]?.label ?? site.type}</td>
                <td className="px-4 py-2">{site.machinesInside.length ? site.machinesInside.map((m) => machineLabel(m)).join(", ") : "—"}</td>
                <td className="px-4 py-2">{site.dwellLimitMinutes ? formatHours(site.dwellLimitMinutes / 60) : "—"}</td>
                <td className="max-w-xs truncate px-4 py-2 text-slate-500">{site.notes ?? ""}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Banner({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200">
      {children}
    </div>
  );
}

function DetailsForm({
  site,
  polygon,
  onCancel,
  onSaved,
}: {
  site: SiteRow | null;
  polygon: Polygon | null;
  onCancel: () => void;
  onSaved: (id: number) => void;
}) {
  const [state, action, pending] = useActionState(saveWorksiteAction, { error: null, savedId: null, version: 0 } as WorksiteFormState);
  const [values, setValues] = useState({
    name: site?.name ?? "",
    type: site?.type ?? "worksite",
    notes: site?.notes ?? "",
    dwellHours: site?.dwellLimitMinutes ? String(Number((site.dwellLimitMinutes / 60).toFixed(2))) : "",
    speedLimit: site?.speedLimitKph ? String(site.speedLimitKph) : "",
  });
  const set = (key: keyof typeof values) => (e: { target: { value: string } }) => setValues((v) => ({ ...v, [key]: e.target.value }));
  useEffect(() => {
    if (state.savedId && !state.error) onSaved(state.savedId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.version]);
  return (
    <form action={action} className={`${card} space-y-3 p-4`}>
      <h2 className="font-semibold">{site ? `Edit ${site.name}` : "New worksite"}</h2>
      <input type="hidden" name="id" value={site?.id ?? ""} />
      {polygon && <input type="hidden" name="polygon" value={JSON.stringify(polygon)} />}
      <label className="block text-sm">
        <span className="text-slate-600 dark:text-slate-400">Name</span>
        <input name="name" required maxLength={80} placeholder="e.g. North Yard" value={values.name} onChange={set("name")} className={field} />
      </label>
      <label className="block text-sm">
        <span className="text-slate-600 dark:text-slate-400">Type</span>
        <select name="type" value={values.type} onChange={set("type")} className={field}>
          {Object.entries(WORKSITE_TYPES).map(([key, t]) => (
            <option key={key} value={key}>
              {t.label}
            </option>
          ))}
        </select>
      </label>
      <label className="block text-sm">
        <span className="text-slate-600 dark:text-slate-400">Time limit (hours, optional)</span>
        <input
          name="dwellHours"
          inputMode="decimal"
          placeholder="e.g. 10"
          value={values.dwellHours}
          onChange={set("dwellHours")}
          className={field}
        />
        <span className="text-xs text-slate-500">For the “Stayed Too Long at Worksite” notification.</span>
      </label>
      <label className="block text-sm">
        <span className="text-slate-600 dark:text-slate-400">Speed limit (km/h, optional)</span>
        <input name="speedLimit" inputMode="decimal" placeholder="e.g. 20" value={values.speedLimit} onChange={set("speedLimit")} className={field} />
        <span className="text-xs text-slate-500">Inside this site, instead of the fleet limit (Settings), for the “Speeding” notification.</span>
      </label>
      {values.type === "restricted" && (
        <p className="rounded bg-rose-50 px-2 py-1.5 text-xs text-rose-900 dark:bg-rose-950 dark:text-rose-200">
          Restricted area: any machine that enters raises an alert straight away (Alerts page and “Restricted Area Entered” notification).
        </p>
      )}
      <label className="block text-sm">
        <span className="text-slate-600 dark:text-slate-400">Notes (optional)</span>
        <textarea name="notes" maxLength={500} rows={2} value={values.notes} onChange={set("notes")} className={field} />
      </label>
      {state.error && <p className="text-sm text-red-600">{state.error}</p>}
      <div className="flex gap-2">
        <button disabled={pending} className={primary}>
          {pending ? "Saving…" : "Save worksite"}
        </button>
        <button type="button" onClick={onCancel} className={button}>
          Cancel
        </button>
      </div>
    </form>
  );
}

/** "Find a place": OpenStreetMap's free address search (Nominatim), to move the map before drawing. */
function PlaceSearch({ onPick }: { onPick: (bounds: [[number, number], [number, number]]) => void }) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<{ name: string; bounds: [[number, number], [number, number]] }[] | null>(null);
  const [busy, setBusy] = useState(false);
  async function search(e: React.FormEvent) {
    e.preventDefault();
    if (!query.trim()) return;
    setBusy(true);
    try {
      const res = await fetch(`https://nominatim.openstreetmap.org/search?format=jsonv2&limit=5&q=${encodeURIComponent(query.trim())}`);
      const rows = (await res.json()) as { display_name: string; boundingbox: [string, string, string, string] }[];
      setResults(
        rows.map((r) => ({
          name: r.display_name,
          bounds: [
            [Number(r.boundingbox[0]), Number(r.boundingbox[2])],
            [Number(r.boundingbox[1]), Number(r.boundingbox[3])],
          ],
        })),
      );
    } catch {
      setResults([]);
    } finally {
      setBusy(false);
    }
  }
  return (
    <form onSubmit={search} className="relative flex gap-1">
      <input
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Find an address or place"
        aria-label="Find an address or place"
        className="w-56 rounded border border-slate-300 bg-transparent px-2 py-1.5 text-sm dark:border-slate-700 sm:w-72"
      />
      <button className={button} disabled={busy}>
        {busy ? "…" : "Find"}
      </button>
      {results && (
        <ul className="absolute left-0 top-full z-[1000] mt-1 w-80 rounded border border-slate-200 bg-white text-sm shadow-lg dark:border-slate-700 dark:bg-slate-900">
          {results.length === 0 && <li className="px-3 py-2 text-slate-500">Nothing found.</li>}
          {results.map((r) => (
            <li key={r.name}>
              <button
                type="button"
                className="w-full px-3 py-2 text-left hover:bg-slate-50 dark:hover:bg-slate-800"
                onClick={() => {
                  onPick(r.bounds);
                  setResults(null);
                }}
              >
                {r.name}
              </button>
            </li>
          ))}
        </ul>
      )}
    </form>
  );
}
