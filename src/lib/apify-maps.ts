import { ApifyClient } from "apify-client";
import { haversineDistanceMeters } from "@/lib/distance";
import type { Place } from "@/types/place";

type ApifyMapsItem = {
  placeId?: string;
  title?: string;
  address?: string;
  location?: { lat?: number; lng?: number };
  totalScore?: number;
  url?: string;
  website?: string;
};

export async function searchWithApifyMaps(
  query: string,
  lat: number,
  lng: number,
  area: string,
  maxResults: number
): Promise<Place[]> {
  const token = process.env.APIFY_TOKEN;
  // Support both naming conventions
  const actorId = process.env.APIFY_MAPS_ACTOR_ID ?? process.env.APIFY_GOOGLE_MAPS_ACTOR_ID;

  console.log("[apify-maps] CONFIG:", JSON.stringify({
    hasToken: !!token,
    actorId: actorId ?? null,
    readFrom: process.env.APIFY_MAPS_ACTOR_ID ? "APIFY_MAPS_ACTOR_ID" : process.env.APIFY_GOOGLE_MAPS_ACTOR_ID ? "APIFY_GOOGLE_MAPS_ACTOR_ID" : "NOT SET",
  }));

  if (!token || !actorId) {
    console.log("[apify-maps] SKIPPED — APIFY_TOKEN or APIFY_MAPS_ACTOR_ID not set");
    return [];
  }

  try {
    const client = new ApifyClient({ token });
    const searchQuery = area ? `${query} in ${area}` : query;
    const input = {
      searchStringsArray: [searchQuery],
      maxCrawledPlacesPerSearch: maxResults,
      language: "en",
      deeperCityScrape: false,
    };

    console.log("[apify-maps] RUN INPUT:", JSON.stringify(input));

    const run = await client.actor(actorId).call(input);

    console.log("[apify-maps] RUN RESULT:", JSON.stringify({
      id: run?.id,
      status: run?.status,
      defaultDatasetId: run?.defaultDatasetId ?? null,
    }));

    if (!run?.defaultDatasetId) {
      console.warn("[apify-maps] no defaultDatasetId — actor may have failed or produced no output");
      return [];
    }

    const { items } = await client.dataset(run.defaultDatasetId).listItems();

    console.log("[apify-maps] RAW DATASET (" + items.length + " items):", JSON.stringify(items, null, 2));

    const places = (items as ApifyMapsItem[])
      .filter(
        (item) =>
          typeof item.location?.lat === "number" &&
          typeof item.location?.lng === "number"
      )
      .map((item) => ({
        id: item.placeId ?? `${item.location!.lat}-${item.location!.lng}`,
        name: item.title?.trim() || "Unnamed place",
        address: item.address?.trim() || "Address unavailable",
        lat: item.location!.lat!,
        lon: item.location!.lng!,
        distanceMeters: haversineDistanceMeters(lat, lng, item.location!.lat!, item.location!.lng!),
        rating: typeof item.totalScore === "number" ? item.totalScore : undefined,
        reviewLink: item.url?.trim() || undefined,
        socialLink: item.website?.trim() || undefined,
      }))
      .sort((a, b) => a.distanceMeters - b.distanceMeters);

    console.log("[apify-maps] MAPPED PLACES (" + places.length + " valid):", JSON.stringify(places, null, 2));

    return places;
  } catch (err) {
    console.error("[apify-maps] ERROR:", err);
    return [];
  }
}
