"use client";

import dynamic from "next/dynamic";
import {
  FormEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { formatDistance } from "@/lib/distance";
import { readResponseJson } from "@/lib/readResponseJson";
import type { Place, UserLocation } from "@/types/place";

const NearbyMap = dynamic(() => import("@/components/sections/NearbyMap"), {
  ssr: false,
});

const DEFAULT_RADIUS_METERS = 5000;
const RADIUS_OPTIONS = [5000, 10000, 15000, 20000, 30000] as const;
const EXPAND_STEPS_METERS = [10000, 20000, 30000, 50000, 80000, 120000, 180000, 250000];
const COMPETITOR_HINT_PATTERN =
  /(software|information technology|it |tech|technology|web|app development|digital|solutions|systems|infotech|consulting)/i;
const COMPETITOR_BUSINESS_KEYWORDS = [
  "solutions",
  "technologies",
  "technology",
  "software",
  "systems",
  "services",
  "consulting",
  "consultancy",
  "agency",
  "studios",
  "digital",
  "company",
  "private limited",
  "pvt ltd",
  "llp",
  "inc",
  "corporation",
  "enterprise",
  "group",
];
const QUERY_STOP_WORDS = new Set([
  "near",
  "me",
  "in",
  "at",
  "around",
  "the",
  "a",
  "an",
  "and",
  "or",
  "for",
  "my",
  "location",
]);
const BUSINESS_KEYWORD_PATTERN =
  /^(shop|store|cafe|center|centre|salon|hospital|bank|restaurant|company|companies|parlour|parlor|gym|hotel|clinic|pharmacy|services|service|agency|development|design|solutions|consulting|consultancy|technology|technologies|web|seo|digital|marketing|software|app|apps|mobile|branding|ui|ux|graphics?)$/i;

type SocialLinkLookup = {
  linkedin?: string;
  instagram?: string;
};

function normalizeUrlInput(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "";
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  if (/^[\w.-]+\.[a-z]{2,}/i.test(trimmed)) return `https://${trimmed}`;
  return trimmed;
}

function queryRequestsNearMe(input: string): boolean {
  const v = input.toLowerCase();
  return /\bnear\s+me\b/.test(v) || /\bmy\s+location\b/.test(v) || /\bcurrent\s+location\b/.test(v);
}

function toFriendlySearchError(message: string): string {
  const lower = message.toLowerCase();
  if (
    lower.includes("google places returned no usable data") ||
    lower.includes("places api (new)") ||
    lower.includes("api key restrictions") ||
    lower.includes("billing")
  ) {
    return "Google data source is unavailable right now. Please enable Places API (New) and billing for your project, or continue with fallback sources.";
  }
  return message;
}

function tokenizeSearchTerm(value: string): string[] {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 3 && !QUERY_STOP_WORDS.has(token));
}

function competitorScore(place: Place, targetTokens: string[]): number {
  const haystack = `${place.name} ${place.address}`.toLowerCase();
  let score = 0;

  if (COMPETITOR_HINT_PATTERN.test(haystack)) score += 4;

  for (const keyword of COMPETITOR_BUSINESS_KEYWORDS) {
    if (haystack.includes(keyword)) score += 2;
  }

  for (const token of targetTokens) {
    if (haystack.includes(token)) score += 3;
  }

  if (place.distanceMeters <= 2000) score += 4;
  else if (place.distanceMeters <= 5000) score += 3;
  else if (place.distanceMeters <= 10000) score += 2;
  else if (place.distanceMeters <= 20000) score += 1;

  // Boost entities with stronger business suffixes in the name.
  if (/(pvt|private|ltd|llp|inc|corp|company|solutions|technologies)/i.test(place.name)) {
    score += 2;
  }

  return score;
}

function ratingLabel(rating: number | undefined): string {
  if (typeof rating !== "number" || Number.isNaN(rating)) return "—";
  return rating.toFixed(1);
}

function compactSocialQuery(value: string): string {
  return value
    .replace(/[|/\\]+/g, " ")
    .replace(/\b(ground floor|first floor|second floor|near|opp|opposite)\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function buildPlaceLinks(
  place: Place,
  scraped?: SocialLinkLookup
): { review: string; linkedin: string; instagram: string } {
  const q = encodeURIComponent(`${place.name} ${place.address}`);
  const review =
    place.reviewLink?.trim() || `https://www.google.com/maps/search/?api=1&query=${q}`;
  const rawSocial = scraped?.linkedin || scraped?.instagram || place.socialLink?.trim() || "";
  const lowerSocial = rawSocial.toLowerCase();
  const cleanName = compactSocialQuery(place.name);
  const addressHint = compactSocialQuery(place.address.split(",")[0] ?? "");

  const linkedin = lowerSocial.includes("linkedin.com")
    ? rawSocial
    : `https://www.google.com/search?q=${encodeURIComponent(`${cleanName} ${addressHint} site:linkedin.com/company`)}`;

  const instagram = lowerSocial.includes("instagram.com")
    ? rawSocial
    : `https://www.google.com/search?q=${encodeURIComponent(`${cleanName} ${addressHint} instagram`)}`;

  return { review, linkedin, instagram };
}

export default function NearbySearchSection() {
  const searchWrapRef = useRef<HTMLDivElement>(null);
  const [businessName, setBusinessName] = useState("");
  const [businessPhone, setBusinessPhone] = useState("");
  const [businessLocation, setBusinessLocation] = useState("");
  const [businessPincode, setBusinessPincode] = useState("");
  const [businessCategory, setBusinessCategory] = useState("");
  const [businessServices, setBusinessServices] = useState("");
  const [reviewLink, setReviewLink] = useState("");
  const [socialLink, setSocialLink] = useState("");
  const [profileReady, setProfileReady] = useState(false);
  const [isPreparingProfile, setIsPreparingProfile] = useState(false);
  const [reportMarkdown, setReportMarkdown] = useState("");
  const [competitorSummaryMarkdown, setCompetitorSummaryMarkdown] = useState("");
  const [competitorSummarySource, setCompetitorSummarySource] = useState<"ai" | "fallback" | "">(
    ""
  );
  const [competitorSummaryReason, setCompetitorSummaryReason] = useState("");
  const [agentQuestion, setAgentQuestion] = useState(
    "How can I beat the top 3 competitors in my area?"
  );
  const [agentAnswer, setAgentAnswer] = useState("");
  const [agentSource, setAgentSource] = useState<"ai" | "fallback" | "">("");
  const [agentReason, setAgentReason] = useState("");
  const [isAgentLoading, setIsAgentLoading] = useState(false);
  const [query, setQuery] = useState("");
  const [fromLocationText, setFromLocationText] = useState("");
  const [suggestions, setSuggestions] = useState<Array<{ id: string; label: string }>>([]);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [radiusMeters, setRadiusMeters] = useState<number>(DEFAULT_RADIUS_METERS);
  const [customRadiusKm, setCustomRadiusKm] = useState<string>("5");
  const [userLocation, setUserLocation] = useState<UserLocation | null>(null);
  const [allPlaces, setAllPlaces] = useState<Place[]>([]);
  const [places, setPlaces] = useState<Place[]>([]);
  const [selectedPlaceId, setSelectedPlaceId] = useState<string | null>(null);
  const [locationDescription, setLocationDescription] = useState<string>("");
  const [hasSearched, setHasSearched] = useState(false);
  const [resultsExpanded, setResultsExpanded] = useState(false);
  const [status, setStatus] = useState<string>(
    "Search for any place or service, set your area, then run a search."
  );
  const [statusTone, setStatusTone] = useState<"neutral" | "success" | "warn" | "error">(
    "neutral"
  );
  const [resultsMode, setResultsMode] = useState<"related" | "competitors">("related");
  const [scrapedSocialLinks, setScrapedSocialLinks] = useState<Record<string, SocialLinkLookup>>(
    {}
  );
  const [isLoading, setIsLoading] = useState(false);
  /** When true, searches without a typed From / without "… in &lt;area&gt;" use live GPS each time. */
  const [usingDeviceLocation, setUsingDeviceLocation] = useState(false);

  const effectiveCenter = useMemo<UserLocation>(
    () => userLocation ?? { lat: 20.5937, lng: 78.9629 },
    [userLocation]
  );

  const competitorInsights = useMemo(() => {
    if (places.length === 0) return null;
    const rated = places.filter((p) => typeof p.rating === "number");
    const avgRating =
      rated.length > 0
        ? rated.reduce((acc, p) => acc + (p.rating ?? 0), 0) / rated.length
        : null;
    const topRated = [...rated].sort((a, b) => (b.rating ?? 0) - (a.rating ?? 0))[0];
    const nearest = [...places].sort((a, b) => a.distanceMeters - b.distanceMeters)[0];
    const focus = (businessCategory || businessServices || query || "business").trim();
    return {
      avgRating: avgRating ? avgRating.toFixed(2) : "N/A",
      focus,
      topRated: topRated
        ? `${topRated.name} (${topRated.rating?.toFixed(1)}★)`
        : "No rating-rich competitor found.",
      nearest: nearest ? `${nearest.name} (${formatDistance(nearest.distanceMeters)})` : "N/A",
      improvement:
        avgRating && avgRating >= 4.2
          ? "Competitors have strong ratings; improve review responses and proof-based posts."
          : "Market ratings are moderate; faster service and stronger review collection can help.",
    };
  }, [places, businessCategory, businessServices, query]);

  const actionPlan = useMemo(() => {
    const source = allPlaces.length > 0 ? allPlaces : places;
    if (source.length === 0) return null;

    const targetTokenSet = new Set<string>([
      ...tokenizeSearchTerm(query),
      ...tokenizeSearchTerm(businessCategory),
      ...tokenizeSearchTerm(businessServices),
      ...tokenizeSearchTerm(businessName),
    ]);
    const targetTokens = [...targetTokenSet];

    const ranked = source
      .map((place) => ({
        place,
        score: competitorScore(place, targetTokens),
      }))
      .sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score;
        return a.place.distanceMeters - b.place.distanceMeters;
      });

    const topThree = ranked.slice(0, 3);
    const rated = source.filter((item) => typeof item.rating === "number");
    const avgRating =
      rated.length > 0
        ? rated.reduce((acc, item) => acc + (item.rating ?? 0), 0) / rated.length
        : null;
    const nearbyCount = source.filter((item) => item.distanceMeters <= 5000).length;

    const recommendations = [
      nearbyCount < 5
        ? "Increase radius to 8-10 km to capture more direct competitors."
        : "Focus outreach on nearest 5 km competitors first.",
      avgRating && avgRating >= 4.4
        ? "Your market has high ratings. Prioritize review response quality and proof-based case studies."
        : "Market ratings are beatable. Faster service + structured review collection can improve position.",
      "Track the top 3 competitors weekly for rating, positioning and offer changes.",
    ];

    return {
      topThree,
      recommendations,
    };
  }, [allPlaces, places, query, businessCategory, businessServices, businessName]);

  useEffect(() => {
    const input = query.trim();
    if (input.length < 2) {
      setSuggestions([]);
      return;
    }

    const timer = setTimeout(async () => {
      try {
        const response = await fetch(
          `/api/places/suggest?` + new URLSearchParams({ input }).toString()
        );
        if (!response.ok) return;
        const body = await readResponseJson<{
          suggestions?: Array<{ id: string; label: string }>;
        }>(response);
        setSuggestions(body.suggestions ?? []);
      } catch {
        setSuggestions([]);
      }
    }, 250);

    return () => clearTimeout(timer);
  }, [query]);

  useEffect(() => {
    const activePlaces = places.slice(0, 12);
    const missing = activePlaces.filter(
      (place) => !scrapedSocialLinks[place.id]?.linkedin && !scrapedSocialLinks[place.id]?.instagram
    );
    if (missing.length === 0) return;

    let cancelled = false;
    const load = async () => {
      const updates: Record<string, SocialLinkLookup> = {};
      for (const place of missing) {
        try {
          const response = await fetch(
            `/api/places/social-links?` +
              new URLSearchParams({
                name: place.name,
                address: place.address,
                website: place.socialLink ?? "",
              }).toString()
          );
          if (!response.ok) continue;
          const body = await readResponseJson<{ linkedin?: string | null; instagram?: string | null }>(
            response
          );
          updates[place.id] = {
            linkedin: body.linkedin ?? undefined,
            instagram: body.instagram ?? undefined,
          };
        } catch {
          // Ignore row-level scraper failures.
        }
      }
      if (!cancelled && Object.keys(updates).length > 0) {
        setScrapedSocialLinks((prev) => ({ ...prev, ...updates }));
      }
    };

    void load();
    return () => {
      cancelled = true;
    };
  }, [places, scrapedSocialLinks]);

  useEffect(() => {
    const top = places.slice(0, 8);
    if (top.length === 0 || !profileReady) {
      setCompetitorSummaryMarkdown("");
      setCompetitorSummarySource("");
      setCompetitorSummaryReason("");
      return;
    }

    let cancelled = false;
    const timer = setTimeout(async () => {
      try {
        const response = await fetch("/api/business/competitor-summary", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            companyName: businessName.trim(),
            companyCategory: businessCategory.trim(),
            companyServices: businessServices.trim(),
            companyLocation: businessLocation.trim(),
            competitors: top.map((item) => ({
              name: item.name,
              address: item.address,
              distanceMeters: item.distanceMeters,
              rating: item.rating,
              website: item.socialLink ?? undefined,
            })),
          }),
        });
        if (!response.ok) return;
        const body = await readResponseJson<{
          markdown?: string;
          source?: "ai" | "fallback";
          reason?: string | null;
        }>(response);
        if (!cancelled) {
          setCompetitorSummaryMarkdown(body.markdown ?? "");
          setCompetitorSummarySource(body.source ?? "");
          setCompetitorSummaryReason(body.reason ?? "");
        }
      } catch {
        if (!cancelled) {
          setCompetitorSummaryMarkdown("");
          setCompetitorSummarySource("");
          setCompetitorSummaryReason("");
        }
      }
    }, 500);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [
    places,
    profileReady,
    businessName,
    businessCategory,
    businessServices,
    businessLocation,
  ]);

  useEffect(() => {
    const onPointerDown = (event: MouseEvent) => {
      const el = searchWrapRef.current;
      if (!el || !(event.target instanceof Node)) return;
      if (!el.contains(event.target)) setShowSuggestions(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    return () => document.removeEventListener("mousedown", onPointerDown);
  }, []);

  const parseQueryAndArea = (input: string): { term: string; area: string } => {
    const value = input.trim().replace(/\s+/g, " ");
    const splitRe = /\s+(?:in|near|around|at)\s+/i;
    const parts = value.split(splitRe);
    if (parts.length > 1) {
      const area = parts.pop()?.trim() ?? "";
      const term = parts.join(" ").trim();
      if (term && area) {
        const normalizedArea = area.toLowerCase();
        if (
          normalizedArea === "me" ||
          normalizedArea === "my location" ||
          normalizedArea === "current location"
        ) {
          return { term, area: "" };
        }
        return { term, area };
      }
    }
    const comma = value.lastIndexOf(",");
    if (comma > 0 && comma < value.length - 1) {
      const term = value.slice(0, comma).trim();
      const area = value.slice(comma + 1).trim();
      if (term && area) return { term, area };
    }
    const atMatch = value.match(/^(.+?)\s+@\s+(.+)$/i);
    if (atMatch) {
      const term = atMatch[1]?.trim() ?? "";
      const area = atMatch[2]?.trim() ?? "";
      if (term && area) return { term, area };
    }
    return { term: value, area: "" };
  };

  /** If the user did not use "in/near/…" or From, try treating the last word as a city (e.g. "medical shop raipur"). */
  const inferAreaFromTerm = (term: string): string | null => {
    const words = term.trim().split(/\s+/).filter(Boolean);
    if (words.length < 2) return null;

    const genericWord = (w: string) => BUSINESS_KEYWORD_PATTERN.test(w);

    // If term contains clear business separators, avoid location inference entirely.
    if (/[&/|]/.test(term)) return null;

    const bad = new Set(["near", "me", "for", "and", "the", "best", "top", "all"]);

    // Pick the right-most token that is not an obvious business keyword.
    for (let i = words.length - 1; i >= 0; i -= 1) {
      const candidate = words[i]!;
      const normalized = candidate.toLowerCase();
      if (candidate.length < 3) continue;
      if (bad.has(normalized)) continue;
      if (genericWord(normalized)) continue;
      return candidate;
    }
    return null;
  };

  const requestCurrentLocation = (): Promise<UserLocation> =>
    new Promise((resolve, reject) => {
      if (!navigator.geolocation) {
        reject(new Error("Geolocation is not supported in this browser."));
        return;
      }

      navigator.geolocation.getCurrentPosition(
        (position) => {
          resolve({
            lat: position.coords.latitude,
            lng: position.coords.longitude,
          });
        },
        () => reject(new Error("Location permission denied. Please allow location access.")),
        { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 }
      );
    });

  const geocodeAddress = async (address: string): Promise<UserLocation> => {
    const response = await fetch(
      `/api/places/geocode?` + new URLSearchParams({ address }).toString()
    );
    const body = await readResponseJson<{
      error?: string;
      lat?: number;
      lng?: number;
      formattedAddress?: string;
    }>(response);
    if (!response.ok) {
      throw new Error(body.error ?? "Could not resolve that location.");
    }
    const lat = body.lat;
    const lng = body.lng;
    if (typeof lat !== "number" || typeof lng !== "number") {
      throw new Error(body.error ?? "Could not resolve that location.");
    }
    setLocationDescription(body.formattedAddress ?? address);
    return { lat, lng };
  };

  /** Short label for From field (first segments of a long address). */
  const shortenAddressLabel = (full: string, maxLen = 72): string => {
    const t = full.trim();
    if (t.length <= maxLen) return t;
    const parts = t.split(",").map((p) => p.trim());
    const short = parts.slice(0, 3).join(", ");
    return short.length <= maxLen ? short : `${t.slice(0, maxLen - 1)}…`;
  };

  const reverseGeocodeLabel = async (coords: UserLocation): Promise<string> => {
    const response = await fetch(
      `/api/places/geocode?` +
        new URLSearchParams({
          lat: String(coords.lat),
          lng: String(coords.lng),
        }).toString()
    );
    const body = await readResponseJson<{
      error?: string;
      formattedAddress?: string;
    }>(response);
    if (!response.ok) {
      return `${coords.lat.toFixed(4)}, ${coords.lng.toFixed(4)}`;
    }
    return body.formattedAddress?.trim() || `${coords.lat.toFixed(4)}, ${coords.lng.toFixed(4)}`;
  };

  type SearchOrigin = { coords: UserLocation; areaHint: string };

  /** Resolves map center: explicit area in query, GPS mode (before From text), manual From, infer, last point. */
  const resolveLocationForSearch = async (
    areaFromQuery: string,
    termForInference: string,
    forceNearMe: boolean
  ): Promise<SearchOrigin> => {
    const area = areaFromQuery.trim();
    const profileLocation = businessLocation.trim();

    if (profileReady && profileLocation && area && BUSINESS_KEYWORD_PATTERN.test(area)) {
      const coords = await geocodeAddress(profileLocation);
      setFromLocationText(profileLocation);
      setUsingDeviceLocation(false);
      return { coords, areaHint: profileLocation };
    }

    if (area) {
      setFromLocationText(area);
      setUsingDeviceLocation(false);
      const coords = await geocodeAddress(area);
      return { coords, areaHint: area };
    }

    if (forceNearMe || usingDeviceLocation) {
      setStatusTone("neutral");
      setStatus("Refreshing your location…");
      const fresh = await requestCurrentLocation();
      setUserLocation(fresh);
      try {
        const label = shortenAddressLabel(await reverseGeocodeLabel(fresh));
        setFromLocationText(label);
        setLocationDescription(label);
      } catch {
        setLocationDescription("Current device location");
      }
      return { coords: fresh, areaHint: "" };
    }

    const manualFrom = fromLocationText.trim();
    if (manualFrom) {
      setUsingDeviceLocation(false);
      const coords = await geocodeAddress(manualFrom);
      return { coords, areaHint: manualFrom };
    }

    const inferredArea = inferAreaFromTerm(termForInference);
    if (inferredArea) {
      setUsingDeviceLocation(false);
      setFromLocationText(inferredArea);
      try {
        const coords = await geocodeAddress(inferredArea);
        return { coords, areaHint: inferredArea };
      } catch {
        setFromLocationText("");
        // If inference guessed a non-location word, fall back to business location before GPS/error.
        if (profileLocation && profileLocation.toLowerCase() !== inferredArea.toLowerCase()) {
          try {
            const coords = await geocodeAddress(profileLocation);
            setFromLocationText(profileLocation);
            return { coords, areaHint: profileLocation };
          } catch {
            // Continue to userLocation / error fallback below.
          }
        }
      }
    }

    if (userLocation) {
      setLocationDescription("Current device location");
      return { coords: userLocation, areaHint: "" };
    }

    throw new Error(
      'Add an area in the search box (e.g. "cafe in Raipur", "pharmacy near Delhi", or "salon, Mumbai"), use From, or tap Use my location.'
    );
  };

  const fetchNearbyWithinRadius = async (
    term: string,
    location: UserLocation,
    selectedRadius: number,
    areaHint?: string,
    osmOnly = false
  ): Promise<{ places: Place[]; expanded: boolean }> => {
    const response = await fetch(
      `/api/places/nearby?` +
        new URLSearchParams({
          query: term,
          lat: String(location.lat),
          lng: String(location.lng),
          radius: String(selectedRadius),
          area: areaHint ?? fromLocationText,
          osmOnly: osmOnly ? "1" : "0",
        }).toString()
    );

    const body = await readResponseJson<{
      places?: Place[];
      error?: string;
      expanded?: boolean;
    }>(response);

    if (!response.ok) {
      throw new Error(body.error ?? "Nearby search failed. Please try again.");
    }
    if (!body.places) {
      throw new Error(body.error ?? "No place data returned.");
    }

    const sorted = [...body.places].sort((a, b) => a.distanceMeters - b.distanceMeters);
    return { places: sorted, expanded: Boolean(body.expanded) };
  };

  const streamNearbyWithinRadius = (
    term: string,
    location: UserLocation,
    selectedRadius: number,
    areaHint?: string,
    osmOnly = false
  ): { close: () => void; done: Promise<{ places: Place[] }> } => {
    const params = new URLSearchParams({
      query: term,
      lat: String(location.lat),
      lng: String(location.lng),
      radius: String(selectedRadius),
      area: areaHint ?? fromLocationText,
      osmOnly: osmOnly ? "1" : "0",
    });

    const es = new EventSource(`/api/places/nearby/stream?${params.toString()}`);
    const collected = new Map<string, Place>();

    const done = new Promise<{ places: Place[] }>((resolve, reject) => {
      es.addEventListener("place", (event) => {
        try {
          const parsed = JSON.parse((event as MessageEvent).data) as { place?: Place };
          if (!parsed.place) return;
          collected.set(parsed.place.id, parsed.place);
          const sorted = [...collected.values()].sort((a, b) => a.distanceMeters - b.distanceMeters);
          setAllPlaces(sorted);
          setPlaces(sorted);
          setSelectedPlaceId((prev) => prev ?? sorted[0]?.id ?? null);
          setStatusTone("neutral");
          setStatus(`Streaming ${sorted.length} place(s)…`);
        } catch {
          // Ignore malformed events.
        }
      });

      es.addEventListener("done", () => {
        es.close();
        const sorted = [...collected.values()].sort((a, b) => a.distanceMeters - b.distanceMeters);
        resolve({ places: sorted });
      });

      es.addEventListener("error", (event) => {
        // EventSource fires "error" for disconnects too; try to extract payload if present.
        try {
          const data = (event as MessageEvent).data;
          if (typeof data === "string" && data.trim()) {
            const parsed = JSON.parse(data) as { error?: string };
            if (parsed.error) reject(new Error(parsed.error));
            else reject(new Error("Streaming connection error."));
            return;
          }
        } catch {
          // ignore
        }
        reject(new Error("Streaming connection error."));
      });
    });

    return { close: () => es.close(), done };
  };

  const fetchFallbackCompetitors = async (
    location: UserLocation,
    selectedRadius: number,
    areaHint: string
  ): Promise<Place[]> => {
    const parsedQuery = parseQueryAndArea(query).term.trim();
    const primaryTerm =
      businessCategory.trim() || businessServices.trim() || parsedQuery || businessName.trim();

    const primary = await fetchNearbyWithinRadius(
      primaryTerm,
      location,
      Math.max(selectedRadius, 12000),
      areaHint,
      true
    );
    if (primary.places.length > 0) return primary.places;

    const broad = await fetchNearbyWithinRadius(
      "company",
      location,
      Math.max(selectedRadius, 12000),
      areaHint,
      true
    );
    if (broad.places.length > 0) return broad.places;

    // Final fallback: widen radius and avoid strict area text for OSM.
    const wider = await fetchNearbyWithinRadius(
      "company",
      location,
      Math.max(selectedRadius, 30000),
      "",
      true
    );
    return wider.places;
  };

  const runSearch = async (term: string, selectedRadius: number): Promise<Place[] | null> => {
    setHasSearched(true);
    setShowSuggestions(false);
    setResultsExpanded(false);
    setStatusTone("neutral");

    const parsed = parseQueryAndArea(term);
    const effectiveTerm = parsed.term;
    const effectiveArea = parsed.area;

    if (!effectiveTerm.trim()) {
      setStatus("Enter what you want to find (for example cafe, pharmacy, IT company).");
      setStatusTone("warn");
      return null;
    }

    setIsLoading(true);
    setStatus("Finding your search location…");

    let locationForFallback: UserLocation | null = null;
    let areaHintForFallback = "";
    let activeStreamCloser: null | (() => void) = null;

    try {
      const wantsNearMe = queryRequestsNearMe(term);
      const { coords: location, areaHint: resolvedAreaHint } = await resolveLocationForSearch(
        effectiveArea,
        effectiveTerm,
        wantsNearMe
      );
      locationForFallback = location;
      setUserLocation(location);
      setStatus(`Searching “${effectiveTerm}” within ${formatDistance(selectedRadius)}…`);

      let effectiveRadius = selectedRadius;
      // Never pass GPS label into Places text query — only explicit area / From / resolved city.
      const areaHint =
        resolvedAreaHint || effectiveArea || fromLocationText.trim();
      areaHintForFallback = areaHint;
      let expandedAny = false;
      let foundPlaces: Place[] = [];

      // Stream results immediately into UI.
      const stream = streamNearbyWithinRadius(effectiveTerm, location, selectedRadius, areaHint);
      activeStreamCloser = stream.close;
      const streamed = await stream.done;
      foundPlaces = streamed.places;

      if (foundPlaces.length === 0) {
        for (const stepRadius of EXPAND_STEPS_METERS) {
          if (stepRadius <= selectedRadius) continue;
          setStatus(
            `No matches in ${formatDistance(effectiveRadius)}. Trying ${formatDistance(stepRadius)}…`
          );
          // For expansion steps, fall back to non-streaming to keep behavior stable.
          const next = await fetchNearbyWithinRadius(effectiveTerm, location, stepRadius, areaHint);
          if (next.expanded) expandedAny = true;
          foundPlaces = next.places;
          if (foundPlaces.length > 0) {
            effectiveRadius = stepRadius;
            break;
          }
          effectiveRadius = stepRadius;
        }
      }

      const uniqueById = new Map(foundPlaces.map((place) => [place.id, place]));
      const sortedPlaces = [...uniqueById.values()].sort(
        (a, b) => a.distanceMeters - b.distanceMeters
      );

      setRadiusMeters(effectiveRadius);
      setResultsExpanded(expandedAny);
      setResultsMode("related");

      setAllPlaces(sortedPlaces);
      setPlaces(sortedPlaces);
      setSelectedPlaceId(sortedPlaces[0]?.id ?? null);

      if (sortedPlaces.length > 0) {
        setStatusTone(expandedAny ? "warn" : "success");
        setStatus(
          expandedAny
            ? `${sortedPlaces.length} place(s) found (nearest matches may be slightly outside ${formatDistance(selectedRadius)}).`
            : `${sortedPlaces.length} place(s) in ${formatDistance(effectiveRadius)} — nearest first.`
        );
      } else {
        setStatusTone("warn");
        setStatus(
          `No results for “${effectiveTerm}” here. Try another keyword or add an area: “${effectiveTerm} in Raipur”.`
        );
      }
      return sortedPlaces;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Something went wrong.";
      try {
        if (locationForFallback) {
          const fallbackPlaces = await fetchFallbackCompetitors(
            locationForFallback,
            selectedRadius,
            areaHintForFallback
          );
          if (fallbackPlaces.length > 0) {
            setAllPlaces(fallbackPlaces);
            setPlaces(fallbackPlaces);
            setSelectedPlaceId(fallbackPlaces[0]?.id ?? null);
            setResultsExpanded(true);
            setResultsMode("related");
            setStatusTone("warn");
            setStatus(
              `Google unavailable. Showing ${fallbackPlaces.length} fallback competitor result(s) from OSM.`
            );
            return fallbackPlaces;
          }
        }
      } catch {
        // Ignore fallback errors and show original message below.
      }

      const friendly = toFriendlySearchError(message);
      setStatusTone("warn");
      setStatus(
        friendly.includes("Google data source is unavailable")
          ? "Google is unavailable. Showing fallback sources when available. Try a broader keyword like 'company' or increase radius."
          : friendly
      );
      // Keep existing list if available; do not blank UI on Google errors.
      if (allPlaces.length === 0) {
        setPlaces([]);
        setAllPlaces([]);
        setSelectedPlaceId(null);
        setResultsExpanded(false);
      }
      return null;
    } finally {
      if (activeStreamCloser) activeStreamCloser();
      setIsLoading(false);
    }
  };

  const showCompetitorsFromCurrentList = async () => {
    let source = allPlaces;
    if (source.length === 0) {
      if (!query.trim()) {
        setStatus("Enter what to search first (e.g. software company), then filter competitors.");
        setStatusTone("warn");
        return;
      }
      const generated = await runSearch(query, radiusMeters);
      source = generated ?? [];
    }
    if (source.length === 0) {
      setStatus("No base results found for this location/query to filter competitors.");
      setStatusTone("warn");
      return;
    }

    const parsed = parseQueryAndArea(query);
    const targetTokenSet = new Set<string>([
      ...tokenizeSearchTerm(parsed.term),
      ...tokenizeSearchTerm(businessCategory),
      ...tokenizeSearchTerm(businessServices),
      ...tokenizeSearchTerm(businessName),
    ]);
    const targetTokens = [...targetTokenSet];

    const ranked = source
      .map((place) => ({
        place,
        score: competitorScore(place, targetTokens),
      }))
      .filter((item) => item.score >= 7)
      .sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score;
        return a.place.distanceMeters - b.place.distanceMeters;
      })
      .map((item) => item.place);

    setPlaces(ranked);
    setResultsMode("competitors");
    setSelectedPlaceId(ranked[0]?.id ?? null);
    setStatusTone(ranked.length > 0 ? "success" : "warn");
    setStatus(
      ranked.length > 0
        ? `${ranked.length} competitor-style match(es), ranked by name/address relevance.`
        : "No competitor-style rows in the current list."
    );
  };

  const showAllFromCurrentList = () => {
    setPlaces(allPlaces);
    setResultsMode("related");
    setSelectedPlaceId(allPlaces[0]?.id ?? null);
    setStatusTone("neutral");
    if (allPlaces.length > 0) {
      setStatus(`Showing all ${allPlaces.length} result(s).`);
    }
  };

  const onSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    await runSearch(query, radiusMeters);
  };

  const onBusinessSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!businessName.trim() || !businessPhone.trim() || !businessLocation.trim()) {
      setStatusTone("warn");
      setStatus("Please fill Company name, number, and location first.");
      return;
    }

    setIsPreparingProfile(true);
    setStatusTone("neutral");
    setStatus("Validating input and scraping links...");

    try {
      const response = await fetch("/api/business/report", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          businessName: businessName.trim(),
          businessPhone: businessPhone.trim(),
          businessLocation: businessLocation.trim(),
          businessPincode: businessPincode.trim(),
          businessCategory: businessCategory.trim(),
          businessServices: businessServices.trim(),
          reviewLink: normalizeUrlInput(reviewLink),
          socialLink: normalizeUrlInput(socialLink),
        }),
      });
      const body = await readResponseJson<{
        error?: string;
        report?: { markdown?: string };
      }>(response);
      if (!response.ok) {
        throw new Error(body.error ?? "Failed to prepare business profile.");
      }

      // Keep map/search anchor aligned with the submitted company location.
      setFromLocationText(businessLocation.trim());
      try {
        // Use entered company location as search/map base immediately.
        const companyCoords = await geocodeAddress(businessLocation.trim());
        setUserLocation(companyCoords);
      } catch {
        // keep manual location text; user can still search
      }
      const baseSearchTerm =
        businessCategory.trim() || businessServices.trim() || businessName.trim();
      const initialSearchTerm = `${baseSearchTerm} in ${businessLocation.trim()}`;
      setQuery(initialSearchTerm);
      setReportMarkdown(body.report?.markdown ?? "");
      setProfileReady(true);
      setStatusTone("success");
      setStatus("Scrape + analysis complete. Loading nearby businesses...");

      // Auto-fetch after continue so map shows real competitor data immediately.
      await runSearch(initialSearchTerm, radiusMeters);
    } catch (error) {
      setStatusTone("error");
      setStatus(error instanceof Error ? error.message : "Could not prepare business profile.");
    } finally {
      setIsPreparingProfile(false);
    }
  };

  const onSearchKeyDown = useCallback((event: React.KeyboardEvent) => {
    if (event.key === "Escape") setShowSuggestions(false);
  }, []);

  const askCompetitorAgent = useCallback(async () => {
    const q = agentQuestion.trim();
    if (!q) return;
    const top = places.slice(0, 8);
    if (top.length === 0) {
      setAgentAnswer("Run a search first so the agent can use competitor data.");
      setAgentSource("fallback");
      setAgentReason("No competitors in current list.");
      return;
    }

    setIsAgentLoading(true);
    try {
      const response = await fetch("/api/business/competitor-agent", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          companyName: businessName.trim(),
          companyCategory: businessCategory.trim(),
          companyServices: businessServices.trim(),
          companyLocation: businessLocation.trim(),
          question: q,
          competitors: top.map((item) => ({
            name: item.name,
            address: item.address,
            distanceMeters: item.distanceMeters,
            rating: item.rating,
            website: item.socialLink ?? undefined,
          })),
        }),
      });
      const body = await readResponseJson<{
        answer?: string;
        source?: "ai" | "fallback";
        reason?: string | null;
        error?: string;
      }>(response);
      if (!response.ok) throw new Error(body.error ?? "Agent request failed.");
      setAgentAnswer(body.answer ?? "");
      setAgentSource(body.source ?? "");
      setAgentReason(body.reason ?? "");
    } catch (error) {
      setAgentAnswer("Could not get agent response right now.");
      setAgentSource("fallback");
      setAgentReason(error instanceof Error ? error.message : "Unknown error");
    } finally {
      setIsAgentLoading(false);
    }
  }, [
    agentQuestion,
    places,
    businessName,
    businessCategory,
    businessServices,
    businessLocation,
  ]);

  if (!profileReady) {
    return (
      <section className="nearby-shell">
        <div className="control-card business-input-card">
          <div className="control-card-header">
            <div>
              <p className="control-card-title">Business Input</p>
              <p className="control-card-hint">
                First enter your company details and links. After submit, map search section will
                appear.
              </p>
            </div>
          </div>

          <form className="business-input-form" onSubmit={onBusinessSubmit}>
            <label className="business-input-field">
              <span>Company name</span>
              <input
                type="text"
                value={businessName}
                onChange={(event) => setBusinessName(event.target.value)}
                placeholder="e.g. NJ Designpark"
                required
              />
            </label>

            <label className="business-input-field">
              <span>Company number</span>
              <input
                type="text"
                value={businessPhone}
                onChange={(event) => setBusinessPhone(event.target.value)}
                placeholder="e.g. +91-7896541230"
                required
              />
            </label>

            <label className="business-input-field">
              <span>Company location</span>
              <input
                type="text"
                value={businessLocation}
                onChange={(event) => setBusinessLocation(event.target.value)}
                placeholder="e.g. Nehru Nagar, Bhilai"
                required
              />
            </label>

            <label className="business-input-field">
              <span>Business category</span>
              <input
                type="text"
                value={businessCategory}
                onChange={(event) => setBusinessCategory(event.target.value)}
                placeholder="e.g. Web Design Agency / IT Company"
              />
            </label>

            <label className="business-input-field">
              <span>Pincode</span>
              <input
                type="text"
                value={businessPincode}
                onChange={(event) => setBusinessPincode(event.target.value)}
                placeholder="e.g. 490020"
              />
            </label>

            <label className="business-input-field">
              <span>Core services</span>
              <input
                type="text"
                value={businessServices}
                onChange={(event) => setBusinessServices(event.target.value)}
                placeholder="e.g. Website, SEO, App Development"
              />
            </label>

            <label className="business-input-field">
              <span>Google reviews link</span>
              <input
                type="text"
                value={reviewLink}
                onChange={(event) => setReviewLink(event.target.value)}
                onBlur={(event) => setReviewLink(normalizeUrlInput(event.target.value))}
                placeholder="https://www.google.com/..."
              />
            </label>

            <label className="business-input-field">
              <span>Social media link</span>
              <input
                type="text"
                value={socialLink}
                onChange={(event) => setSocialLink(event.target.value)}
                onBlur={(event) => setSocialLink(normalizeUrlInput(event.target.value))}
                placeholder="https://in.linkedin.com/company/..."
              />
            </label>

            <button
              className="btn btn-primary business-input-submit"
              type="submit"
              disabled={isPreparingProfile}
            >
              {isPreparingProfile ? "Preparing..." : "Continue to map section"}
            </button>
          </form>

          <div className="business-input-note">
            {status}
          </div>
        </div>
      </section>
    );
  }

  return (
    <section className="nearby-shell">
      <div className="control-card">
        <div className="control-card-header">
          <div>
            <p className="control-card-title">Search</p>
          </div>
        </div>

        <form onSubmit={onSubmit}>
          <div className="search-row">
            <div className="search-wrap" ref={searchWrapRef}>
              <div className="search-input-wrap">
                <span className="search-input-icon" aria-hidden>
                  ⌕
                </span>
                <input
                  className="search-input"
                  type="search"
                  autoComplete="off"
                  value={query}
                  onKeyDown={onSearchKeyDown}
                  onChange={(event) => {
                    setQuery(event.target.value);
                    setShowSuggestions(true);
                  }}
                  onFocus={() => setShowSuggestions(true)}
                  placeholder='Try "medical shop in Bhilai" or "restaurant"'
                  aria-label="Search places or services"
                />
              </div>
              {showSuggestions && suggestions.length > 0 ? (
                <div className="suggestions-list" role="listbox">
                  {suggestions.map((item) => (
                    <button
                      key={item.id}
                      type="button"
                      className="suggestion-item"
                      role="option"
                      aria-selected={false}
                      onClick={() => {
                        setQuery(item.label);
                        setShowSuggestions(false);
                      }}
                    >
                      {item.label}
                    </button>
                  ))}
                </div>
              ) : null}
            </div>
            <button className="btn btn-primary" type="submit" disabled={isLoading}>
              {isLoading ? "Searching…" : "Search"}
            </button>
          </div>
        </form>

        <div className="from-row">
          <input
            className="from-input"
            type="text"
            value={fromLocationText}
            onChange={(event) => {
              const v = event.target.value;
              setFromLocationText(v);
              if (v.trim().length > 0) setUsingDeviceLocation(false);
            }}
            placeholder="From: filled automatically when you use GPS, or type a city"
            aria-label="Starting location"
          />
          <button
            className={`btn btn-secondary${usingDeviceLocation && userLocation ? " btn-location-on" : ""}`}
            type="button"
            disabled={isLoading}
            aria-pressed={usingDeviceLocation && Boolean(userLocation)}
            onClick={async () => {
              try {
                setStatusTone("neutral");
                setStatus("Detecting your location…");
                const current = await requestCurrentLocation();
                setUserLocation(current);
                setUsingDeviceLocation(true);
                setStatus("Looking up address for your location…");
                try {
                  const label = shortenAddressLabel(await reverseGeocodeLabel(current));
                  setFromLocationText(label);
                  setLocationDescription(label);
                } catch {
                  setFromLocationText(
                    `${current.lat.toFixed(4)}, ${current.lng.toFixed(4)}`
                  );
                  setLocationDescription("Current device location");
                }
                setStatus(
                  "Location saved — From shows your area. Search e.g. “spa” to find places near you."
                );
                setStatusTone("success");
              } catch {
                setUsingDeviceLocation(false);
                setStatusTone("warn");
                setStatus("Location blocked. Enter a From address or area instead.");
              }
            }}
          >
            Use my location
          </button>
        </div>
        {usingDeviceLocation && userLocation ? (
          <p className="location-mode-banner" role="status">
            <span className="location-mode-dot" aria-hidden />
            Device location is <strong>active</strong> — searches like <strong>spa</strong> or{" "}
            <strong>hotel</strong> use your GPS (refreshed each search). Use &quot;… in City&quot; in
            the search box to search a different town instead.
          </p>
        ) : null}

        <div className="radius-section">
          <span className="radius-label">Search radius</span>
          <div className="radius-row">
            {RADIUS_OPTIONS.map((value) => (
              <button
                key={value}
                type="button"
                className={`radius-pill ${radiusMeters === value ? "active" : ""}`}
                onClick={() => {
                  setRadiusMeters(value);
                  setCustomRadiusKm(String(value / 1000));
                  if (userLocation || usingDeviceLocation) void runSearch(query, value);
                }}
              >
                {value / 1000} km
              </button>
            ))}
            <label className="radius-custom">
              <span>Custom km</span>
              <input
                type="number"
                min={1}
                step={1}
                value={customRadiusKm}
                onChange={(event) => setCustomRadiusKm(event.target.value)}
                onBlur={() => {
                  const parsedKm = Number(customRadiusKm);
                  if (!Number.isFinite(parsedKm) || parsedKm <= 0) return;
                  const customMeters = Math.round(parsedKm * 1000);
                  setRadiusMeters(customMeters);
                  if (userLocation || usingDeviceLocation) void runSearch(query, customMeters);
                }}
                aria-label="Custom radius in kilometers"
              />
            </label>
          </div>
        </div>

        <div className="actions-row">
          <button
            className="btn btn-secondary"
            type="button"
            disabled={isLoading}
            onClick={() => void showCompetitorsFromCurrentList()}
          >
            Filter competitors
          </button>
          <button
            className="btn btn-ghost"
            type="button"
            disabled={isLoading || allPlaces.length === 0}
            onClick={showAllFromCurrentList}
          >
            Show full list
          </button>
        </div>
        {reportMarkdown ? (
          <div className="business-report-inline">
            <h3>Business analysis</h3>
            <pre>{reportMarkdown}</pre>
          </div>
        ) : null}
        {competitorInsights ? (
          <div className="competitor-insights-inline">
            <h3>Competitor insights</h3>
            <div className="competitor-insights-grid">
              <div>
                <strong>Search focus:</strong> {competitorInsights.focus}
              </div>
              <div>
                <strong>Average rating:</strong> {competitorInsights.avgRating}
              </div>
              <div>
                <strong>Top competitor:</strong> {competitorInsights.topRated}
              </div>
              <div>
                <strong>Nearest competitor:</strong> {competitorInsights.nearest}
              </div>
            </div>
            <p>{competitorInsights.improvement}</p>
          </div>
        ) : null}
        {actionPlan ? (
          <div className="action-plan-inline">
            <h3>Top competitor action plan</h3>
            <div className="action-plan-list">
              {actionPlan.topThree.map((item, index) => (
                <div key={item.place.id} className="action-plan-item">
                  <strong>
                    {index + 1}. {item.place.name}
                  </strong>
                  <span>
                    Score {item.score} · {formatDistance(item.place.distanceMeters)} · ★{" "}
                    {ratingLabel(item.place.rating)}
                  </span>
                </div>
              ))}
            </div>
            <ul className="action-plan-reco">
              {actionPlan.recommendations.map((tip) => (
                <li key={tip}>{tip}</li>
              ))}
            </ul>
          </div>
        ) : null}
        {competitorSummaryMarkdown ? (
          <div className="business-report-inline">
            <h3>
              AI competitor summary{" "}
              {competitorSummarySource ? `(${competitorSummarySource.toUpperCase()})` : ""}
            </h3>
            {competitorSummaryReason ? (
              <p className="control-card-hint">Reason: {competitorSummaryReason}</p>
            ) : null}
            <pre>{competitorSummaryMarkdown}</pre>
          </div>
        ) : null}
        <div className="business-report-inline">
          <h3>Competitor AI Agent {agentSource ? `(${agentSource.toUpperCase()})` : ""}</h3>
          <div className="search-row">
            <input
              className="search-input"
              value={agentQuestion}
              onChange={(event) => setAgentQuestion(event.target.value)}
              placeholder="Ask strategy question..."
            />
            <button
              className="btn btn-secondary"
              type="button"
              disabled={isAgentLoading}
              onClick={() => void askCompetitorAgent()}
            >
              {isAgentLoading ? "Asking..." : "Ask agent"}
            </button>
          </div>
          {agentReason ? <p className="control-card-hint">Reason: {agentReason}</p> : null}
          {agentAnswer ? <pre>{agentAnswer}</pre> : null}
        </div>
      </div>

      {hasSearched ? (
        <div className="content-grid">
          <div className="map-panel">
            <NearbyMap
              center={effectiveCenter}
              places={places}
              radiusMeters={radiusMeters}
              selectedPlaceId={selectedPlaceId}
              onSelectPlace={setSelectedPlaceId}
            />
            {isLoading ? (
              <div className="map-loading-overlay" aria-live="polite">
                <div className="map-loading-inner">
                  <span className="spinner" aria-hidden />
                  Updating map…
                </div>
              </div>
            ) : null}
            <div
              className="status-chip"
              data-tone={
                statusTone === "success"
                  ? "success"
                  : statusTone === "warn"
                    ? "warn"
                    : statusTone === "error"
                      ? "error"
                      : undefined
              }
            >
              {status}
            </div>
            {locationDescription ? (
              <div className="from-chip">From: {locationDescription}</div>
            ) : null}
            {reviewLink ? (
              <a
                className="map-link-chip"
                href={normalizeUrlInput(reviewLink)}
                target="_blank"
                rel="noreferrer"
              >
                Review link
              </a>
            ) : null}
            {socialLink ? (
              <a
                className="map-link-chip secondary"
                href={normalizeUrlInput(socialLink)}
                target="_blank"
                rel="noreferrer"
              >
                Social media link
              </a>
            ) : null}
          </div>

          <aside className="results-panel">
            <div className="results-panel-header">
              <h2>{resultsMode === "competitors" ? "Competitor companies" : "Related companies"}</h2>
              <p className="results-meta">
                {places.length} {places.length === 1 ? "place" : "places"}
                {resultsExpanded ? " · includes nearest outside strict radius" : ""}
              </p>
            </div>
            <div className="results-list">
              {places.length === 0 ? (
                <div className="result-empty">
                  No rows for this search. Try a different keyword, widen radius, or add an area
                  (e.g. “in Mumbai”).
                </div>
              ) : (
                places.map((place, index) => (
                  <div
                    key={place.id}
                    className={`result-card ${selectedPlaceId === place.id ? "active" : ""}`}
                    role="button"
                    tabIndex={0}
                    onClick={() => setSelectedPlaceId(place.id)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        setSelectedPlaceId(place.id);
                      }
                    }}
                  >
                    <span className="result-index">{index + 1}</span>
                    <p className="result-title">{place.name}</p>
                    <p className="result-address">{place.address}</p>
                    <div className="result-footer">
                      <span className="badge badge-distance">{formatDistance(place.distanceMeters)}</span>
                      <span className="badge badge-rating">★ {ratingLabel(place.rating)}</span>
                    </div>
                    <div className="result-links">
                      <a
                        href={buildPlaceLinks(place, scrapedSocialLinks[place.id]).review}
                        target="_blank"
                        rel="noreferrer"
                        onClick={(event) => event.stopPropagation()}
                      >
                        Review link
                      </a>
                      <a
                        href={buildPlaceLinks(place, scrapedSocialLinks[place.id]).linkedin}
                        target="_blank"
                        rel="noreferrer"
                        onClick={(event) => event.stopPropagation()}
                      >
                        LinkedIn
                      </a>
                      <a
                        href={buildPlaceLinks(place, scrapedSocialLinks[place.id]).instagram}
                        target="_blank"
                        rel="noreferrer"
                        onClick={(event) => event.stopPropagation()}
                      >
                        Instagram
                      </a>
                    </div>
                  </div>
                ))
              )}
            </div>
          </aside>
        </div>
      ) : (
        <div className="presearch-panel">
          <h3>Start with input first</h3>
          <p>Enter what you want to search and click Search. Map and results will appear after that.</p>
        </div>
      )}
    </section>
  );
}
