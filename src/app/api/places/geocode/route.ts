import { NextRequest, NextResponse } from "next/server";

type GoogleGeocodeResponse = {
  status?: string;
  results?: Array<{
    formatted_address?: string;
    geometry?: {
      location?: {
        lat?: number;
        lng?: number;
      };
    };
  }>;
};

const GOOGLE_GEOCODE_ENDPOINT = "https://maps.googleapis.com/maps/api/geocode/json";
const NOMINATIM_SEARCH_ENDPOINT = "https://nominatim.openstreetmap.org/search";

type NominatimResult = {
  lat?: string;
  lon?: string;
  display_name?: string;
  importance?: number;
  addresstype?: string;
};

const CITY_FALLBACKS: Record<string, { lat: number; lng: number; formattedAddress: string }> = {
  raipur: { lat: 21.2380912, lng: 81.6336993, formattedAddress: "Raipur, Chhattisgarh, India" },
  durg: { lat: 21.1896499, lng: 81.2851077, formattedAddress: "Durg, Chhattisgarh, India" },
  bhilai: { lat: 21.1938, lng: 81.3509, formattedAddress: "Bhilai, Chhattisgarh, India" },
  delhi: { lat: 28.6138954, lng: 77.2090057, formattedAddress: "New Delhi, Delhi, India" },
};

function scoreNominatimResult(item: NominatimResult): number {
  const base = typeof item.importance === "number" ? item.importance : 0;
  const type = (item.addresstype ?? "").toLowerCase();
  const typeBoost =
    type === "city" || type === "state" || type === "county" || type === "administrative"
      ? 0.5
      : 0;
  return base + typeBoost;
}

export async function GET(request: NextRequest) {
  const apiKey = process.env.GOOGLE_MAPS_API_KEY ?? process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY;

  const address = request.nextUrl.searchParams.get("address")?.trim();
  if (!address) {
    return NextResponse.json({ error: "address is required." }, { status: 400 });
  }

  if (apiKey) {
    const params = new URLSearchParams({
      key: apiKey,
      address,
    });

    try {
      const response = await fetch(`${GOOGLE_GEOCODE_ENDPOINT}?${params.toString()}`, {
        cache: "no-store",
      });
      if (response.ok) {
        const data = (await response.json()) as GoogleGeocodeResponse;
        const first = data.results?.[0];
        const lat = first?.geometry?.location?.lat;
        const lng = first?.geometry?.location?.lng;
        if (typeof lat === "number" && typeof lng === "number") {
          return NextResponse.json({
            lat,
            lng,
            formattedAddress: first?.formatted_address ?? address,
          });
        }
      }
    } catch {
      // Fall through to Nominatim fallback below.
    }
  }

  try {
    const queryVariants = [address, `${address}, India`];
    const collected: NominatimResult[] = [];

    for (const q of queryVariants) {
      const paramSets = [
        new URLSearchParams({
          q,
          format: "json",
          limit: "8",
          addressdetails: "1",
          countrycodes: "in",
        }),
        new URLSearchParams({
          q,
          format: "json",
          limit: "8",
          addressdetails: "1",
        }),
      ];

      for (const params of paramSets) {
        const fallback = await fetch(`${NOMINATIM_SEARCH_ENDPOINT}?${params.toString()}`, {
          headers: {
            "User-Agent": "near-me-app/1.0",
          },
          cache: "no-store",
        });
        if (!fallback.ok) continue;
        const data = (await fallback.json()) as NominatimResult[];
        collected.push(...data);
        if (data.length > 0) break;
      }
    }

    if (collected.length === 0) {
      const normalized = address.toLowerCase().trim();
      const fallback =
        CITY_FALLBACKS[normalized] ??
        Object.entries(CITY_FALLBACKS).find(([key]) => normalized.includes(key))?.[1];
      if (fallback) {
        return NextResponse.json(fallback);
      }
      return NextResponse.json({ error: "Could not resolve the location." }, { status: 404 });
    }

    const best = [...collected].sort((a, b) => scoreNominatimResult(b) - scoreNominatimResult(a))[0];
    const first = best;
    const lat = Number(first?.lat);
    const lng = Number(first?.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      return NextResponse.json({ error: "Could not resolve the location." }, { status: 404 });
    }

    return NextResponse.json({
      lat,
      lng,
      formattedAddress: first?.display_name ?? address,
    });
  } catch {
    return NextResponse.json({ error: "Unexpected server error while geocoding." }, { status: 500 });
  }
}
