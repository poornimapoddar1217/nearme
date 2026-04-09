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
  if (!apiKey) {
    return NextResponse.json(
      { error: "Missing GOOGLE_MAPS_API_KEY in environment variables." },
      { status: 500 }
    );
  }

  const address = request.nextUrl.searchParams.get("address")?.trim();
  if (!address) {
    return NextResponse.json({ error: "address is required." }, { status: 400 });
  }

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

  try {
    const queryVariants = [address, `${address}, India`];
    const collected: NominatimResult[] = [];

    for (const q of queryVariants) {
      const fallback = await fetch(
        `${NOMINATIM_SEARCH_ENDPOINT}?` +
          new URLSearchParams({
            q,
            format: "json",
            limit: "5",
            addressdetails: "1",
            countrycodes: "in",
          }).toString(),
        {
          headers: {
            "User-Agent": "near-me-app/1.0",
          },
          cache: "no-store",
        }
      );
      if (!fallback.ok) continue;
      const data = (await fallback.json()) as NominatimResult[];
      collected.push(...data);
    }

    if (collected.length === 0) {
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
