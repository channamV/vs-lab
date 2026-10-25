"use client";

import "leaflet/dist/leaflet.css";
import type { Map as LeafletMap, LayerGroup } from "leaflet";
import { useRouter } from "next/navigation";
import { useEffect, useRef } from "react";
import type { ConnectionStatus } from "@/lib/data";
import { WORKSITE_TYPES, worksiteColor, type WorksiteType } from "@/lib/worksite-types";
import { splitSegments, trackGaps } from "@/lib/history-track";

export interface MapMarker {
  /** Machine ID: clicking the marker opens the machine. */
  id: number;
  label: string;
  lat: number;
  lng: number;
  status: ConnectionStatus;
}

/** A worksite outline drawn under the machines (see /worksites). */
export interface MapSite {
  id: number;
  name: string;
  type: string;
  polygon: [number, number][];
}

const STATUS_COLORS: Record<ConnectionStatus, string> = {
  online: "#059669",
  recent: "#d97706",
  offline: "#64748b",
};

/**
 * Map of machine positions (and optionally a track line). Uses Leaflet with OpenStreetMap tiles —
 * no API key needed. For production traffic, switch to a paid tile provider (OSM's tiles are for light use).
 */
export function FleetMap({
  markers,
  track,
  sites = [],
  height = 420,
}: {
  markers: MapMarker[];
  /** With times (`at`), the line breaks where the device was silent and the gap is drawn dashed (no data). */
  track?: { lat: number; lng: number; at?: Date | string }[];
  sites?: MapSite[];
  height?: number;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<LeafletMap | null>(null);
  const layerRef = useRef<LayerGroup | null>(null);
  const fittedRef = useRef(false);
  const router = useRouter();

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const L = await import("leaflet");
      if (cancelled || !containerRef.current) return;

      if (!mapRef.current) {
        mapRef.current = L.map(containerRef.current, { scrollWheelZoom: false }).setView([45, -40], 3);
        L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
          maxZoom: 19,
          attribution: "&copy; OpenStreetMap contributors",
        }).addTo(mapRef.current);
        layerRef.current = L.layerGroup().addTo(mapRef.current);
      }
      const map = mapRef.current;
      const layer = layerRef.current!;
      layer.clearLayers();

      const bounds: [number, number][] = [];
      for (const site of sites) {
        L.polygon(site.polygon, { color: worksiteColor(site.type), weight: 1.5, fillOpacity: 0.12 })
          .bindTooltip(`${site.name} · ${WORKSITE_TYPES[site.type as WorksiteType]?.label ?? site.type}`, { sticky: true })
          .on("click", () => router.push("/worksites"))
          .addTo(layer);
      }
      if (track && track.length > 1) {
        const timed = track.map((p, i) => ({ lat: p.lat, lng: p.lng, t: p.at ? new Date(p.at).getTime() : i }));
        const segments = track[0].at ? splitSegments(timed) : [timed];
        for (const seg of segments) {
          L.polyline(seg.map((p) => [p.lat, p.lng] as [number, number]), { color: "#0284c7", weight: 3, opacity: 0.8 }).addTo(layer);
        }
        for (const g of trackGaps(segments)) {
          L.polyline(
            [
              [g.from.lat, g.from.lng],
              [g.to.lat, g.to.lng],
            ],
            { color: "#64748b", weight: 2, opacity: 0.8, dashArray: "6 8" },
          )
            .bindTooltip(`No data for ${Math.max(1, g.minutes)} min (no signal?): route unknown`, { sticky: true })
            .addTo(layer);
        }
        bounds.push(...timed.map((p) => [p.lat, p.lng] as [number, number]));
      }
      for (const m of markers) {
        L.circleMarker([m.lat, m.lng], {
          radius: 9,
          color: "#ffffff",
          weight: 2,
          fillColor: STATUS_COLORS[m.status],
          fillOpacity: 1,
        })
          .bindTooltip(m.label)
          .on("click", () => {
            router.push(`/machines/${m.id}`);
          })
          .addTo(layer);
        bounds.push([m.lat, m.lng]);
      }

      // Zoom to the data once; after that, keep whatever view the user chose.
      if (!fittedRef.current && bounds.length > 0) {
        map.fitBounds(bounds, { padding: [40, 40], maxZoom: 16 });
        fittedRef.current = true;
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [markers, track, sites, router]);

  // Next.js keeps a page you've left alive and tears its effects down (and up again on "back"): a rebuilt map
  // starts at the world view, so it must zoom to the machines again.
  useEffect(
    () => () => {
      mapRef.current?.remove();
      mapRef.current = null;
      fittedRef.current = false;
    },
    [],
  );

  return (
    <div
      ref={containerRef}
      style={{ height }}
      className="z-0 w-full overflow-hidden rounded-lg border border-slate-200 dark:border-slate-800"
    />
  );
}
