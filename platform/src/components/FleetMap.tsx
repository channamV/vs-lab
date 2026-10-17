"use client";

import "leaflet/dist/leaflet.css";
import type { Map as LeafletMap, LayerGroup } from "leaflet";
import { useRouter } from "next/navigation";
import { useEffect, useRef } from "react";
import type { ConnectionStatus } from "@/lib/data";

export interface MapMarker {
  /** Machine ID: clicking the marker opens the machine. */
  id: number;
  label: string;
  lat: number;
  lng: number;
  status: ConnectionStatus;
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
  height = 420,
}: {
  markers: MapMarker[];
  track?: { lat: number; lng: number }[];
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
      if (track && track.length > 1) {
        const line = track.map((p) => [p.lat, p.lng] as [number, number]);
        L.polyline(line, { color: "#0284c7", weight: 3, opacity: 0.8 }).addTo(layer);
        bounds.push(...line);
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
  }, [markers, track, router]);

  useEffect(
    () => () => {
      mapRef.current?.remove();
      mapRef.current = null;
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
