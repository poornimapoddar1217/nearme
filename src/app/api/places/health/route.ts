import { NextRequest, NextResponse } from "next/server";

const PLACES_SEARCH_TEXT = "https://places.googleapis.com/v1/places:searchText";
const GEOCODE = "https://maps.googleapis.com/maps/api/geocode/json";
const AUTOCOMPLETE = "https://maps.googleapis.com/maps/api/place/autocomplete/json";

/** Last 4 chars only — enough to confirm Vercel picked the right key without exposing the full secret. */
function keySuffix(key: string | undefined): string | null {
  if (!key || key.length < 4) return null;
  return key.slice(-4);
}

type ProbeResult = {
  ok: boolean;
  httpStatus: number;
  /** Google Geocoding / Autocomplete `status` when present */
  googleStatus?: string;
  /** Error message from JSON body when available */
  message?: string;
};

export async function GET(request: NextRequest) {
  const probe = request.nextUrl.searchParams.get("probe") !== "false";

  const serverKey = process.env.GOOGLE_MAPS_API_KEY;
  const publicKey = process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY;
  const effectiveKey = serverKey ?? publicKey;
  const keySource: "GOOGLE_MAPS_API_KEY" | "NEXT_PUBLIC_GOOGLE_MAPS_API_KEY" | "none" = serverKey
    ? "GOOGLE_MAPS_API_KEY"
    : publicKey
      ? "NEXT_PUBLIC_GOOGLE_MAPS_API_KEY"
      : "none";

  const base = {
    timestamp: new Date().toISOString(),
    keys: {
      GOOGLE_MAPS_API_KEY: { set: Boolean(serverKey), suffix: keySuffix(serverKey) },
      NEXT_PUBLIC_GOOGLE_MAPS_API_KEY: { set: Boolean(publicKey), suffix: keySuffix(publicKey) },
      effectiveForServerRoutes: {
        source: keySource,
        suffix: keySuffix(effectiveKey),
      },
    },
    probesSkipped: !probe,
  };

  if (!probe || !effectiveKey) {
    return NextResponse.json({
      ...base,
      summary:
        !effectiveKey
          ? "No API key for server routes. Set GOOGLE_MAPS_API_KEY in Vercel (recommended) or NEXT_PUBLIC_GOOGLE_MAPS_API_KEY."
          : "Probes skipped (probe=false).",
      placesNew: null as ProbeResult | null,
      geocoding: null as ProbeResult | null,
      placeAutocomplete: null as ProbeResult | null,
    });
  }

  // Raipur — stable test point used elsewhere in the app
  const lat = 21.2380912;
  const lng = 81.6336993;

  const placesNew = await probePlacesNew(effectiveKey, lat, lng);
  const geocoding = await probeGeocode(effectiveKey);
  const placeAutocomplete = await probeAutocomplete(effectiveKey);

  const failed = [placesNew, geocoding, placeAutocomplete].filter((p) => !p.ok);
  let summary = "All Google probes succeeded.";
  if (failed.length > 0) {
    summary = `Some probes failed (${failed.length}/3). Typical fixes: enable billing, enable Places API (New) + Geocoding API + Places API in APIs & Services, and use a server key without HTTP referrer restriction (IP restriction or none for Vercel).`;
  }

  return NextResponse.json({
    ...base,
    summary,
    placesNew,
    geocoding,
    placeAutocomplete,
  });
}

async function probePlacesNew(
  apiKey: string,
  lat: number,
  lng: number
): Promise<ProbeResult> {
  try {
    const response = await fetch(PLACES_SEARCH_TEXT, {
      method: "POST",
      cache: "no-store",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": apiKey,
        "X-Goog-FieldMask": "places.id,places.displayName",
      },
      body: JSON.stringify({
        textQuery: "cafe",
        maxResultCount: 1,
        locationBias: {
          circle: {
            center: { latitude: lat, longitude: lng },
            radius: 5000,
          },
        },
        rankPreference: "DISTANCE",
        languageCode: "en",
      }),
    });

    const httpStatus = response.status;
    const data = (await response.json()) as {
      error?: { status?: string; message?: string };
    };

    if (!response.ok) {
      return {
        ok: false,
        httpStatus,
        message: data.error?.message ?? response.statusText,
        googleStatus: data.error?.status,
      };
    }
    if (data.error?.message) {
      return {
        ok: false,
        httpStatus,
        googleStatus: data.error?.status,
        message: data.error.message,
      };
    }
    return { ok: true, httpStatus };
  } catch (e) {
    return {
      ok: false,
      httpStatus: 0,
      message: e instanceof Error ? e.message : "Network error",
    };
  }
}

async function probeGeocode(apiKey: string): Promise<ProbeResult> {
  try {
    const params = new URLSearchParams({
      key: apiKey,
      address: "Raipur, India",
    });
    const response = await fetch(`${GEOCODE}?${params.toString()}`, { cache: "no-store" });
    const httpStatus = response.status;
    const data = (await response.json()) as {
      status?: string;
      error_message?: string;
    };

    if (!response.ok) {
      return { ok: false, httpStatus, message: data.error_message };
    }
    if (data.status && data.status !== "OK" && data.status !== "ZERO_RESULTS") {
      return {
        ok: false,
        httpStatus,
        googleStatus: data.status,
        message: data.error_message ?? data.status,
      };
    }
    return { ok: true, httpStatus, googleStatus: data.status };
  } catch (e) {
    return {
      ok: false,
      httpStatus: 0,
      message: e instanceof Error ? e.message : "Network error",
    };
  }
}

async function probeAutocomplete(apiKey: string): Promise<ProbeResult> {
  try {
    const params = new URLSearchParams({
      key: apiKey,
      input: "cafe rai",
    });
    const response = await fetch(`${AUTOCOMPLETE}?${params.toString()}`, { cache: "no-store" });
    const httpStatus = response.status;
    const data = (await response.json()) as {
      status?: string;
      error_message?: string;
    };

    if (!response.ok) {
      return { ok: false, httpStatus, message: data.error_message };
    }
    if (data.status && data.status !== "OK" && data.status !== "ZERO_RESULTS") {
      return {
        ok: false,
        httpStatus,
        googleStatus: data.status,
        message: data.error_message ?? data.status,
      };
    }
    return { ok: true, httpStatus, googleStatus: data.status };
  } catch (e) {
    return {
      ok: false,
      httpStatus: 0,
      message: e instanceof Error ? e.message : "Network error",
    };
  }
}
