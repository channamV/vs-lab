-- Engine-on periods detected from vibration only get no GPS distance (a machine on a trailer can look like it's
-- running): work out again the ones already stored from GPS (src/lib/distance.ts).
UPDATE "engine_sessions" SET "distance_km" = NULL, "distance_source" = NULL WHERE "source" = 'vibration' AND "distance_source" = 'gps';
