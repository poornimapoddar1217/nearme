import { NextRequest } from "next/server";
import { haversineDistanceMeters } from "@/lib/distance";
import { searchWithApifyMaps } from "@/lib/apify-maps";
import type { Place } from "@/types/place";

type GoogleNearbyResponse = {
  places?: GoogleNewPlaceResult[];
  error?: {
    message?: string;
    status?: string;
  };
};

type GoogleNewPlaceResult = {
  id?: string;
  displayName?: {
    text?: string;
  };
  formattedAddress?: string;
  rating?: number;
  googleMapsUri?: string;
  websiteUri?: string;
  nationalPhoneNumber?: string;
  internationalPhoneNumber?: string;
  userRatingCount?: number;
  location?: {
    latitude?: number;
    longitude?: number;
  };
};

const GOOGLE_TEXT_NEW_ENDPOINT = "https://places.googleapis.com/v1/places:searchText";
const NOMINATIM_SEARCH_ENDPOINT = "https://nominatim.openstreetmap.org/search";
const GOOGLE_TIMEOUT_MS = 4500;
const OSM_TIMEOUT_MS = 2500;
const MAX_SEARCH_TERMS = 6;
const TARGET_RESULTS = 20;

function sseEvent(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

async function parseJsonSafe<T>(response: Response): Promise<T | null> {
  try {
    const text = await response.text();
    if (!text.trim()) return null;
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

function getSearchTerms(query: string): string[] {
  const raw = query.trim();
  const base = raw.toLowerCase();
  const terms = new Set<string>();
  if (raw.length > 0) terms.add(raw);
  terms.add(base);
  return [...terms].filter(Boolean);
}

function toPlace(item: GoogleNewPlaceResult, userLat: number, userLng: number): Place | null {
  const lat = item.location?.latitude;
  const lon = item.location?.longitude;
  if (typeof lat !== "number" || typeof lon !== "number") return null;

  return {
    id: item.id ?? `${lat}-${lon}`,
    name: item.displayName?.text?.trim() || "Unnamed place",
    address: item.formattedAddress?.trim() || "Address unavailable",
    lat,
    lon,
    rating: typeof item.rating === "number" ? item.rating : undefined,
    reviewLink: item.googleMapsUri?.trim() || undefined,
    socialLink: item.websiteUri?.trim() || undefined,
    distanceMeters: haversineDistanceMeters(userLat, userLng, lat, lon),
  };
}

async function searchTextNew(params: {
  apiKey: string;
  textQuery: string;
  lat: number;
  lng: number;
  radius: number;
}): Promise<{ places: Place[]; error?: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), GOOGLE_TIMEOUT_MS);
  const response = await fetch(GOOGLE_TEXT_NEW_ENDPOINT, {
    method: "POST",
    cache: "no-store",
    signal: controller.signal,
    headers: {
      "Content-Type": "application/json",
      "X-Goog-Api-Key": params.apiKey,
      "X-Goog-FieldMask":
        "places.id,places.displayName,places.formattedAddress,places.location,places.rating,places.userRatingCount,places.googleMapsUri,places.websiteUri,places.nationalPhoneNumber,places.internationalPhoneNumber",
    },
    body: JSON.stringify({
      textQuery: params.textQuery,
      maxResultCount: 20,
      locationBias: {
        circle: {
          center: {
            latitude: params.lat,
            longitude: params.lng,
          },
          radius: Math.min(Math.max(params.radius, 1000), 50000),
        },
      },
      rankPreference: "DISTANCE",
      languageCode: "en",
    }),
  }).finally(() => clearTimeout(timer));

  const data = await parseJsonSafe<GoogleNearbyResponse>(response);
  if (!response.ok) {
    const reason = data?.error?.message ?? `HTTP ${response.status}`;
    return { places: [], error: reason };
  }
  if (!data) {
    return { places: [], error: `Google response was not JSON (HTTP ${response.status})` };
  }
  if (data.error?.message) {
    return { places: [], error: `${data.error.status ?? "ERROR"}: ${data.error.message}` };
  }

  const places =
    data.places
      ?.map((item) => toPlace(item, params.lat, params.lng))
      .filter((item): item is Place => Boolean(item)) ?? [];
  return { places };
}

function toNominatimViewbox(lat: number, lng: number, radiusMeters: number): string {
  const earthRadius = 6371000;
  const dLat = (radiusMeters / earthRadius) * (180 / Math.PI);
  const dLng = dLat / Math.cos((lat * Math.PI) / 180);
  const left = lng - dLng;
  const top = lat + dLat;
  const right = lng + dLng;
  const bottom = lat - dLat;
  return `${left},${top},${right},${bottom}`;
}

export async function GET(request: NextRequest) {
  const apiKey = process.env.GOOGLE_MAPS_API_KEY ?? process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY;

  const query = request.nextUrl.searchParams.get("query")?.trim();
  const area = request.nextUrl.searchParams.get("area")?.trim() ?? "";
  const osmOnly = request.nextUrl.searchParams.get("osmOnly") === "1";
  const lat = Number(request.nextUrl.searchParams.get("lat"));
  const lng = Number(request.nextUrl.searchParams.get("lng"));
  const radius = Number(request.nextUrl.searchParams.get("radius") ?? "5000");

  if (!query) {
    return new Response(sseEvent("error", { error: "query is required." }), {
      status: 400,
      headers: {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
      },
    });
  }
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    return new Response(sseEvent("error", { error: "Valid lat/lng are required." }), {
      status: 400,
      headers: {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
      },
    });
  }
  if (!Number.isFinite(radius) || radius <= 0) {
    return new Response(sseEvent("error", { error: "radius must be a positive number." }), {
      status: 400,
      headers: {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
      },
    });
  }

  const headers = {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  };

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();
      const send = (event: string, data: unknown) => controller.enqueue(encoder.encode(sseEvent(event, data)));

      let pingTimer: ReturnType<typeof setInterval> | null = null;
      const seen = new Set<string>();

      const run = async () => {
        pingTimer = setInterval(() => send("ping", { ts: Date.now() }), 15000);
        send("meta", { query, area, lat, lng, radius, osmOnly });

        try {
          const terms = getSearchTerms(query).slice(0, MAX_SEARCH_TERMS);
          const googleErrors: string[] = [];
          let totalEmitted = 0;

          // Apify Google Maps scraper takes priority when configured.
          if (!osmOnly) {
            const apifyPlaces = await searchWithApifyMaps(query, lat, lng, area, TARGET_RESULTS);
            for (const place of apifyPlaces) {
              if (place.distanceMeters > radius) continue;
              if (seen.has(place.id)) continue;
              seen.add(place.id);
              totalEmitted++;
              send("place", { place, source: "apify" });
              if (totalEmitted >= TARGET_RESULTS) break;
            }
          }

          if (apiKey && !osmOnly && totalEmitted === 0) {
            for (const searchTerm of terms) {
              const textQuery = area ? `${searchTerm} in ${area}` : searchTerm;
              const result = await searchTextNew({ apiKey, textQuery, lat, lng, radius });
              if (result.error) googleErrors.push(result.error);

              for (const place of result.places) {
                if (place.distanceMeters > radius) continue;
                if (seen.has(place.id)) continue;
                seen.add(place.id);
                totalEmitted += 1;
                send("place", { place });
                if (totalEmitted >= TARGET_RESULTS) break;
              }
              if (totalEmitted >= TARGET_RESULTS) break;
            }
          }

          // If Google is unavailable or returned nothing, stream an OSM fallback pass.
          if (totalEmitted === 0) {
            const viewbox = toNominatimViewbox(lat, lng, radius);
            const params = new URLSearchParams({
              q: area ? `${query} ${area}` : query,
              format: "json",
              limit: "40",
              bounded: "1",
              viewbox,
            });

            const osmController = new AbortController();
            const osmTimer = setTimeout(() => osmController.abort(), OSM_TIMEOUT_MS);
            const response = await fetch(`${NOMINATIM_SEARCH_ENDPOINT}?${params.toString()}`, {
              headers: { "User-Agent": "near-me-app/1.0" },
              cache: "no-store",
              signal: osmController.signal,
            }).finally(() => clearTimeout(osmTimer));

            if (response.ok) {
              const data =
                (await parseJsonSafe<
                  Array<{ place_id?: number; display_name?: string; lat?: string; lon?: string }>
                >(response)) ?? [];

              for (const item of data) {
                const itemLat = Number(item.lat);
                const itemLng = Number(item.lon);
                if (!Number.isFinite(itemLat) || !Number.isFinite(itemLng)) continue;
                const distanceMeters = haversineDistanceMeters(lat, lng, itemLat, itemLng);
                if (distanceMeters > radius) continue;
                const [name, ...rest] = (item.display_name ?? "").split(",");
                const place: Place = {
                  id: String(item.place_id ?? `${itemLat}-${itemLng}`),
                  name: name?.trim() || "Unnamed place",
                  address: rest.slice(0, 2).join(",").trim() || "Address unavailable",
                  lat: itemLat,
                  lon: itemLng,
                  distanceMeters,
                };
                if (seen.has(place.id)) continue;
                seen.add(place.id);
                totalEmitted += 1;
                send("place", { place, source: "osm" });
                if (totalEmitted >= TARGET_RESULTS) break;
              }
            }
          }

          send("done", { total: totalEmitted });
        } catch (error) {
          const message =
            error instanceof Error ? error.message : "Unexpected server error while streaming places.";
          send("error", { error: message });
        } finally {
          if (pingTimer) clearInterval(pingTimer);
          controller.close();
        }
      };

      void run();

      request.signal.addEventListener("abort", () => {
        if (pingTimer) clearInterval(pingTimer);
        controller.close();
      });
    },
  });

  return new Response(stream, { headers });
}

