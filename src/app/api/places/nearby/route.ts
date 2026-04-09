import { NextRequest, NextResponse } from "next/server";
import { haversineDistanceMeters } from "@/lib/distance";
import type { Place } from "@/types/place";

type GoogleNearbyResponse = {
  next_page_token?: string;
  results?: GoogleNearbyResult[];
  status?: string;
};

type GoogleNearbyResult = {
  place_id?: string;
  name?: string;
  rating?: number;
  vicinity?: string;
  geometry?: {
    location?: {
      lat?: number;
      lng?: number;
    };
  };
};

const GOOGLE_NEARBY_ENDPOINT = "https://maps.googleapis.com/maps/api/place/nearbysearch/json";
const GOOGLE_TEXT_ENDPOINT = "https://maps.googleapis.com/maps/api/place/textsearch/json";
const NOMINATIM_SEARCH_ENDPOINT = "https://nominatim.openstreetmap.org/search";

function getSearchTerms(query: string): string[] {
  const base = query.trim().toLowerCase();
  const terms = new Set<string>([base]);

  // Common India-friendly synonym expansion for better hit rates.
  if (base.includes("medical shop")) {
    terms.add("pharmacy");
    terms.add("chemist");
    terms.add("drugstore");
  }
  if (base.includes("chemist")) {
    terms.add("pharmacy");
    terms.add("medical store");
  }
  if (base.includes("medical store")) {
    terms.add("pharmacy");
    terms.add("chemist");
  }
  if (base === "cafe") {
    terms.add("coffee shop");
    terms.add("tea cafe");
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

  return [...terms];
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function toPlace(
  item: GoogleNearbyResult,
  userLat: number,
  userLng: number
): Place | null {
  const lat = item.geometry?.location?.lat;
  const lon = item.geometry?.location?.lng;
  if (typeof lat !== "number" || typeof lon !== "number") return null;

  return {
    id: item.place_id ?? `${lat}-${lon}`,
    name: item.name?.trim() || "Unnamed place",
    address: item.vicinity?.trim() || "Address unavailable",
    lat,
    lon,
    rating: typeof item.rating === "number" ? item.rating : undefined,
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

export async function GET(request: NextRequest) {
  const apiKey = process.env.GOOGLE_MAPS_API_KEY ?? process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY;
  if (!apiKey) {
    return NextResponse.json(
      { error: "Missing GOOGLE_MAPS_API_KEY in environment variables." },
      { status: 500 }
    );
  }

  const query = request.nextUrl.searchParams.get("query")?.trim();
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
    const searchTerms = getSearchTerms(query);
    let pageToken: string | undefined;
    const collected = new Map<string, Place>();

    for (const searchTerm of searchTerms) {
      pageToken = undefined;
      for (let page = 0; page < 4; page += 1) {
        const params = new URLSearchParams({
          key: apiKey,
          location: `${lat},${lng}`,
          radius: String(Math.round(radius)),
          keyword: searchTerm,
        });
        if (pageToken) params.set("pagetoken", pageToken);

        const response = await fetch(`${GOOGLE_NEARBY_ENDPOINT}?${params.toString()}`, {
          cache: "no-store",
        });
        if (!response.ok) {
          return NextResponse.json({ error: "Google Places request failed." }, { status: 502 });
        }

        const data = (await response.json()) as GoogleNearbyResponse;
        const results = data.results ?? [];
        results
          .map((item) => toPlace(item, lat, lng))
          .filter((item): item is Place => Boolean(item))
          .forEach((item) => collected.set(item.id, item));

        if (!data.next_page_token) break;
        pageToken = data.next_page_token;
        await wait(2000);
      }
    }

    let places = [...collected.values()].sort((a, b) => a.distanceMeters - b.distanceMeters);

    // Improve completeness: add text-search candidates even if nearby search returned some results.
    if (places.length < 20) {
      let textPageToken: string | undefined;
      for (const searchTerm of searchTerms) {
        textPageToken = undefined;
        for (let page = 0; page < 3; page += 1) {
          const textParams = new URLSearchParams({
            key: apiKey,
            query: searchTerm,
            location: `${lat},${lng}`,
            radius: String(Math.round(radius)),
          });
          if (textPageToken) textParams.set("pagetoken", textPageToken);

          const textResponse = await fetch(`${GOOGLE_TEXT_ENDPOINT}?${textParams.toString()}`, {
            cache: "no-store",
          });
          if (!textResponse.ok) break;

          const textData = (await textResponse.json()) as GoogleNearbyResponse;
          const textResults = textData.results ?? [];
          textResults
            .map((item) => toPlace(item, lat, lng))
            .filter((item): item is Place => Boolean(item))
            .forEach((item) => collected.set(item.id, item));

          if (!textData.next_page_token) break;
          textPageToken = textData.next_page_token;
          await wait(2000);
        }
      }

      places = [...collected.values()].sort((a, b) => a.distanceMeters - b.distanceMeters);
    }

    let withinRadius = places.filter((item) => item.distanceMeters <= radius);

    // Demo/limited keys may return too few records; bounded fallback improves local completeness.
    if (withinRadius.length < 8) {
      const viewbox = toNominatimViewbox(lat, lng, radius);
      const fallbackCollected = new Map<string, Place>(places.map((item) => [item.id, item]));

      for (const searchTerm of searchTerms) {
        const fallback = await fetch(
          `${NOMINATIM_SEARCH_ENDPOINT}?` +
            new URLSearchParams({
              q: searchTerm,
              format: "json",
              limit: "50",
              bounded: "1",
              viewbox,
            }).toString(),
          {
            headers: {
              "User-Agent": "near-me-app/1.0",
            },
            cache: "no-store",
          }
        );
        if (!fallback.ok) continue;

        const data = (await fallback.json()) as Array<{
          place_id?: number;
          display_name?: string;
          lat?: string;
          lon?: string;
        }>;

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
          .forEach((item) => fallbackCollected.set(item.id, item));
      }

      places = [...fallbackCollected.values()].sort((a, b) => a.distanceMeters - b.distanceMeters);
      withinRadius = places.filter((item) => item.distanceMeters <= radius);
    }

    return NextResponse.json({ places: withinRadius });
  } catch {
    return NextResponse.json(
      { error: "Unexpected server error while fetching places." },
      { status: 500 }
    );
  }
}
