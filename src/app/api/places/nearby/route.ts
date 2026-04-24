import { NextRequest, NextResponse } from "next/server";
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
  location?: {
    latitude?: number;
    longitude?: number;
  };
};

const GOOGLE_TEXT_NEW_ENDPOINT = "https://places.googleapis.com/v1/places:searchText";
const NOMINATIM_SEARCH_ENDPOINT = "https://nominatim.openstreetmap.org/search";
const MAX_SEARCH_TERMS = 6;
const TARGET_RESULTS = 20;
const MIN_RELATED_RESULTS = 6;
const GOOGLE_TIMEOUT_MS = 4500;
const OSM_TIMEOUT_MS = 2500;

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

  // Common India-friendly synonym expansion for better hit rates.
  if (base.includes("medical shop") || base.includes("medicine shop")) {
    terms.add("pharmacy");
    terms.add("chemist");
    terms.add("drugstore");
    terms.add("medical store");
  }
  if (base.includes("chemist")) {
    terms.add("pharmacy");
    terms.add("medical store");
  }
  if (base.includes("medical store")) {
    terms.add("pharmacy");
    terms.add("chemist");
  }
  if (base === "cafe" || base.includes("coffee")) {
    terms.add("cafe");
    terms.add("coffee shop");
    terms.add("coffee");
  }
  if (base.includes("restaurant") || base.includes("restaurants")) {
    terms.add("restaurant");
    terms.add("dining");
  }
  if (base.includes("hotel") || base.includes("lodging") || base.includes("lodge")) {
    terms.add("hotel");
    terms.add("guest house");
    terms.add("lodge");
    terms.add("inn");
    terms.add("budget hotel");
    terms.add("hotel accommodation");
  }
  if (base.includes("atm") || base.includes("cash")) {
    terms.add("atm");
  }
  if (base.includes("gym") || base.includes("fitness")) {
    terms.add("gym");
    terms.add("fitness center");
  }
  if (base.includes("hospital") || base.includes("clinic")) {
    terms.add("hospital");
    terms.add("clinic");
  }
  if (base.includes("bank") && !base.includes("blood bank")) {
    terms.add("bank");
    terms.add("bank branch");
    terms.add("commercial bank");
    terms.add("public sector bank");
    terms.add("cooperative bank");
  }
  if (base.includes("petrol") || base.includes("fuel") || base.includes("gas station")) {
    terms.add("petrol pump");
    terms.add("gas station");
  }
  if (base.includes("salon")) {
    terms.add("beauty salon");
    terms.add("hair salon");
    terms.add("unisex salon");
    terms.add("barber shop");
    terms.add("beauty parlour");
  }
  if (base.includes("spa") || base.includes("wellness") || base.includes("massage")) {
    terms.add("spa");
    terms.add("day spa");
    terms.add("beauty spa");
    terms.add("massage center");
    terms.add("wellness center");
  }
  if (base.includes("it company") || base.includes("it companies")) {
    terms.add("software company");
    terms.add("technology company");
    terms.add("tech company");
    terms.add("information technology company");
  }
  if (base.includes("software company")) {
    terms.add("it company");
    terms.add("tech company");
  }
  if (
    base.includes("web design") ||
    base.includes("development agency") ||
    base.includes("digital agency") ||
    base.includes("design agency")
  ) {
    terms.add("web design company");
    terms.add("website development company");
    terms.add("software company");
    terms.add("it company");
    terms.add("digital marketing agency");
  }
  if (base.includes("supermarket") || (base.includes("grocery") && !base.includes("kirana"))) {
    terms.add("supermarket");
    terms.add("grocery store");
  }
  if (
    base.includes("kirana") ||
    base.includes("kiran") ||
    base.includes("general store") ||
    base.includes("provision store") ||
    base.includes("departmental store") ||
    base.includes("mini mart") ||
    base.includes("minimart") ||
    base.includes("corner shop") ||
    base.includes("mom and pop") ||
    (base.includes("grocery") && base.includes("shop"))
  ) {
    terms.add("kirana store");
    terms.add("general store");
    terms.add("grocery store");
    terms.add("convenience store");
    terms.add("provision store");
    terms.add("supermarket");
    terms.add("departmental store");
  }
  if (
    base.includes("ice cream") ||
    base.includes("icecream") ||
    base.includes("gelato") ||
    base.includes("kulfi") ||
    base.includes("frozen dessert")
  ) {
    terms.add("ice cream shop");
    terms.add("ice cream parlor");
    terms.add("ice cream parlour");
    terms.add("dessert shop");
    terms.add("sweet shop");
  }
  if (base.includes("school") || base.includes("college")) {
    terms.add("school");
    terms.add("college");
  }

  return [...terms];
}

/** Drop near-duplicate pins (same coordinates from Google + OSM). */
function dedupeByCoordinates(places: Place[]): Place[] {
  const byCoord = new Map<string, Place>();
  const sorted = [...places].sort((a, b) => a.distanceMeters - b.distanceMeters);
  for (const p of sorted) {
    const key = `${p.lat.toFixed(4)},${p.lon.toFixed(4)}`;
    if (!byCoord.has(key)) byCoord.set(key, p);
  }
  return [...byCoord.values()].sort((a, b) => a.distanceMeters - b.distanceMeters);
}

function toPlace(
  item: GoogleNewPlaceResult,
  userLat: number,
  userLng: number
): Place | null {
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

async function searchTextNew(
  apiKey: string,
  textQuery: string,
  lat: number,
  lng: number,
  radius: number
): Promise<{ places: Place[]; error?: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), GOOGLE_TIMEOUT_MS);
  const response = await fetch(GOOGLE_TEXT_NEW_ENDPOINT, {
    method: "POST",
    cache: "no-store",
    signal: controller.signal,
    headers: {
      "Content-Type": "application/json",
      "X-Goog-Api-Key": apiKey,
      "X-Goog-FieldMask":
        "places.id,places.displayName,places.formattedAddress,places.location,places.rating,places.googleMapsUri,places.websiteUri",
    },
    body: JSON.stringify({
      textQuery,
      maxResultCount: 20,
      locationBias: {
        circle: {
          center: {
            latitude: lat,
            longitude: lng,
          },
          radius: Math.min(Math.max(radius, 1000), 50000),
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
      ?.map((item) => toPlace(item, lat, lng))
      .filter((item): item is Place => Boolean(item)) ?? [];
  return { places };
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
    return NextResponse.json({ error: "query is required." }, { status: 400 });
  }
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    return NextResponse.json({ error: "Valid lat/lng are required." }, { status: 400 });
  }
  if (!Number.isFinite(radius) || radius <= 0) {
    return NextResponse.json({ error: "radius must be a positive number." }, { status: 400 });
  }

  try {
    // Apify Google Maps scraper takes priority when configured.
    if (!osmOnly) {
      const apifyPlaces = await searchWithApifyMaps(query, lat, lng, area, TARGET_RESULTS);
      if (apifyPlaces.length > 0) {
        const deduped = dedupeByCoordinates(apifyPlaces);
        const withinRadius = deduped.filter((p) => p.distanceMeters <= radius);
        return NextResponse.json({
          places: withinRadius.length > 0 ? withinRadius : deduped.slice(0, 20),
          expanded: withinRadius.length === 0,
          source: "apify",
        });
      }
    }

    const googleErrors: string[] = [];
    const searchTerms = getSearchTerms(query).slice(0, MAX_SEARCH_TERMS);
    const collected = new Map<string, Place>();

    if (apiKey && !osmOnly) {
      for (const searchTerm of searchTerms) {
        const textQuery = area ? `${searchTerm} in ${area}` : searchTerm;
        const result = await searchTextNew(apiKey, textQuery, lat, lng, radius);
        if (result.error) {
          googleErrors.push(result.error);
        }
        result.places.forEach((item) => collected.set(item.id, item));
        if (collected.size >= TARGET_RESULTS) break;
      }
    }

    let places = dedupeByCoordinates([...collected.values()]);

    // Improve completeness: add text-search candidates even if nearby search returned some results.
    if (apiKey && !osmOnly && places.length < 20) {
      for (const searchTerm of searchTerms) {
        const textQuery = area ? `${searchTerm} in ${area}` : searchTerm;
        const result = await searchTextNew(apiKey, textQuery, lat, lng, Math.max(radius, 15000));
        if (result.error) googleErrors.push(result.error);
        result.places.forEach((item) => collected.set(item.id, item));
        if (collected.size >= TARGET_RESULTS * 2) break;
      }

      places = dedupeByCoordinates([...collected.values()]);
    }

    let withinRadius = places.filter((item) => item.distanceMeters <= radius);

    // OSM only when Google returned nothing — avoids polluting good Google lists with unrelated POIs.
    if (places.length === 0) {
      const osmSearchTerms = (osmOnly ? searchTerms.slice(0, 2) : searchTerms.slice(0, 4)).filter(
        Boolean
      );
      const viewbox = toNominatimViewbox(lat, lng, radius);
      const maxOsmKm = Math.min(Math.max(radius / 1000, 20), 80);
      const fallbackCollected = new Map<string, Place>(places.map((item) => [item.id, item]));

      const runNominatimPass = async (bounded: "0" | "1") => {
        for (const searchTerm of osmSearchTerms) {
          const candidateQueries = [
            area ? `${searchTerm} ${area} India` : `${searchTerm} India`,
            area ? `company in ${area}` : "company",
          ];

          for (const nominatimQuery of candidateQueries) {
            if (fallbackCollected.size >= TARGET_RESULTS * 2) return;
            const params = new URLSearchParams({
              q: nominatimQuery,
              format: "json",
              limit: "25",
              countrycodes: "in",
            });
            if (bounded === "1") {
              params.set("bounded", "1");
              params.set("viewbox", viewbox);
            }

            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), OSM_TIMEOUT_MS);
            const fallback = await fetch(`${NOMINATIM_SEARCH_ENDPOINT}?${params.toString()}`, {
              headers: {
                "User-Agent": "near-me-app/1.0",
              },
              cache: "no-store",
              signal: controller.signal,
            }).finally(() => clearTimeout(timer));
            if (!fallback.ok) continue;

            const data = (await parseJsonSafe<
              Array<{
                place_id?: number;
                display_name?: string;
                lat?: string;
                lon?: string;
              }>
            >(fallback)) ?? [];

            data
              .map((item) => {
                const itemLat = Number(item.lat);
                const itemLng = Number(item.lon);
                if (!Number.isFinite(itemLat) || !Number.isFinite(itemLng)) return null;
                const [name, ...rest] = (item.display_name ?? "").split(",");
                return {
                  id: String(item.place_id ?? `${itemLat}-${itemLng}`),
                  name: name?.trim() || "Unnamed place",
                  address: rest.slice(0, 2).join(",").trim() || "Address unavailable",
                  lat: itemLat,
                  lon: itemLng,
                  distanceMeters: haversineDistanceMeters(lat, lng, itemLat, itemLng),
                } as Place;
              })
              .filter((item): item is Place => Boolean(item))
              .filter((item) => item.distanceMeters <= maxOsmKm * 1000)
              .forEach((item) => fallbackCollected.set(item.id, item));
          }
        }
      };

      await runNominatimPass("1");
      places = dedupeByCoordinates([...fallbackCollected.values()]);
      if (places.length === 0 && !osmOnly) {
        await runNominatimPass("0");
        places = dedupeByCoordinates([...fallbackCollected.values()]);
      }

      withinRadius = places.filter((item) => item.distanceMeters <= radius);
    }

    // If we got too few nearby rows, enrich with a short OSM pass to improve list completeness.
    if (withinRadius.length > 0 && withinRadius.length < MIN_RELATED_RESULTS) {
      const enrichQueries = [
        area ? `${query} ${area} India` : `${query} India`,
        area ? `company in ${area}` : "company",
      ];
      const enrichCollected = new Map<string, Place>(places.map((item) => [item.id, item]));
      const viewbox = toNominatimViewbox(lat, lng, Math.max(radius, 12000));

      for (const enrichQuery of enrichQueries) {
        const params = new URLSearchParams({
          q: enrichQuery,
          format: "json",
          limit: "40",
          countrycodes: "in",
          bounded: "1",
          viewbox,
        });
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), OSM_TIMEOUT_MS);
        const response = await fetch(`${NOMINATIM_SEARCH_ENDPOINT}?${params.toString()}`, {
          headers: {
            "User-Agent": "near-me-app/1.0",
          },
          cache: "no-store",
          signal: controller.signal,
        }).finally(() => clearTimeout(timer));
        if (!response.ok) continue;

        const data = (await parseJsonSafe<
          Array<{
            place_id?: number;
            display_name?: string;
            lat?: string;
            lon?: string;
          }>
        >(response)) ?? [];

        data
          .map((item) => {
            const itemLat = Number(item.lat);
            const itemLng = Number(item.lon);
            if (!Number.isFinite(itemLat) || !Number.isFinite(itemLng)) return null;
            const [name, ...rest] = (item.display_name ?? "").split(",");
            return {
              id: String(item.place_id ?? `${itemLat}-${itemLng}`),
              name: name?.trim() || "Unnamed place",
              address: rest.slice(0, 2).join(",").trim() || "Address unavailable",
              lat: itemLat,
              lon: itemLng,
              distanceMeters: haversineDistanceMeters(lat, lng, itemLat, itemLng),
            } as Place;
          })
          .filter((item): item is Place => Boolean(item))
          .filter((item) => item.distanceMeters <= radius)
          .forEach((item) => enrichCollected.set(item.id, item));

        if (enrichCollected.size >= TARGET_RESULTS) break;
      }

      places = dedupeByCoordinates([...enrichCollected.values()]);
      withinRadius = places.filter((item) => item.distanceMeters <= radius);
    }

    // Last Google-only fallback: broad text search without radius bias.
    if (withinRadius.length === 0 && places.length === 0 && apiKey && !osmOnly) {
      const broadCollected = new Map<string, Place>();
      for (const searchTerm of searchTerms) {
        const textQuery = area ? `${searchTerm} in ${area}` : searchTerm;
        const result = await searchTextNew(apiKey, textQuery, lat, lng, 50000);
        if (result.error) googleErrors.push(result.error);
        result.places.forEach((item) => broadCollected.set(item.id, item));
      }
      places = dedupeByCoordinates([...broadCollected.values()]);
    }

    // Never return empty if Google has any nearest matches.
    if (withinRadius.length === 0 && places.length > 0) {
      return NextResponse.json({
        places: dedupeByCoordinates(places).slice(0, 20),
        expanded: true,
      });
    }

    if (!osmOnly && withinRadius.length === 0 && places.length === 0 && googleErrors.length > 0) {
      const reason = googleErrors[0];
      return NextResponse.json(
        { error: `Google Places returned no usable data (${reason}). Check API key restrictions/billing.` },
        { status: 502 }
      );
    }

    if (osmOnly && withinRadius.length === 0 && places.length === 0) {
      return NextResponse.json({ places: [], expanded: false, source: "osm-only" });
    }

    return NextResponse.json({ places: dedupeByCoordinates(withinRadius), expanded: false });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unexpected server error while fetching places.";
    return NextResponse.json(
      { error: message },
      { status: 500 }
    );
  }
}
