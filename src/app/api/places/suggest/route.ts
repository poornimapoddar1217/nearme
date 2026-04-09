import { NextRequest, NextResponse } from "next/server";

type GoogleAutocompleteResponse = {
  predictions?: Array<{
    place_id?: string;
    description?: string;
  }>;
};

const GOOGLE_AUTOCOMPLETE_ENDPOINT = "https://maps.googleapis.com/maps/api/place/autocomplete/json";
const NOMINATIM_SEARCH_ENDPOINT = "https://nominatim.openstreetmap.org/search";

function buildHeuristicSuggestions(input: string): Array<{ id: string; label: string }> {
  const value = input.trim();
  if (!value) return [];

  const popularCities = ["raipur", "bhilai", "durg", "pune", "mumbai", "delhi", "bangalore"];
  const out: Array<{ id: string; label: string }> = [];

  if (/\sin\s/i.test(value)) {
    out.push({ id: `${value}-1`, label: value });
  } else {
    popularCities.forEach((city) => {
      out.push({ id: `${value}-${city}`, label: `${value} in ${city}` });
    });
  }

  return out.slice(0, 8);
}

export async function GET(request: NextRequest) {
  const apiKey = process.env.GOOGLE_MAPS_API_KEY ?? process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY;

  const input = request.nextUrl.searchParams.get("input")?.trim() ?? "";
  if (input.length < 2) {
    return NextResponse.json({ suggestions: [] });
  }

  if (apiKey) {
    try {
      const params = new URLSearchParams({
        key: apiKey,
        input,
      });
      const response = await fetch(`${GOOGLE_AUTOCOMPLETE_ENDPOINT}?${params.toString()}`, {
        cache: "no-store",
      });

      if (response.ok) {
        const data = (await response.json()) as GoogleAutocompleteResponse;
        const suggestions =
          data.predictions
            ?.map((item) => ({
              id: item.place_id ?? item.description ?? "",
              label: item.description ?? "",
            }))
            .filter((item) => item.label.length > 0)
            .slice(0, 8) ?? [];

        if (suggestions.length > 0) {
          return NextResponse.json({ suggestions });
        }
      }
    } catch {
      // Continue to fallback.
    }
  }

  try {
    const fallback = await fetch(
      `${NOMINATIM_SEARCH_ENDPOINT}?` +
        new URLSearchParams({
          q: input,
          format: "json",
          limit: "8",
        }).toString(),
      {
        headers: {
          "User-Agent": "near-me-app/1.0",
        },
        cache: "no-store",
      }
    );

    if (!fallback.ok) {
      return NextResponse.json({ suggestions: buildHeuristicSuggestions(input) });
    }

    const data = (await fallback.json()) as Array<{
      place_id?: number;
      display_name?: string;
    }>;

    const suggestions = data
      .map((item) => ({
        id: String(item.place_id ?? item.display_name ?? ""),
        label: item.display_name ?? "",
      }))
      .filter((item) => item.label.length > 0)
      .slice(0, 8);
    if (suggestions.length > 0) {
      return NextResponse.json({ suggestions });
    }
    return NextResponse.json({ suggestions: buildHeuristicSuggestions(input) });
  } catch {
    return NextResponse.json({ suggestions: buildHeuristicSuggestions(input) });
  }
}
