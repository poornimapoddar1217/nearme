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

function ratingLabel(rating: number | undefined): string {
  if (typeof rating !== "number" || Number.isNaN(rating)) return "—";
  return rating.toFixed(1);
}

export default function NearbySearchSection() {
  const searchWrapRef = useRef<HTMLDivElement>(null);
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
  const [isLoading, setIsLoading] = useState(false);
  /** When true, searches without a typed From / without "… in &lt;area&gt;" use live GPS each time. */
  const [usingDeviceLocation, setUsingDeviceLocation] = useState(false);

  const effectiveCenter = useMemo<UserLocation>(
    () => userLocation ?? { lat: 20.5937, lng: 78.9629 },
    [userLocation]
  );

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
      if (term && area) return { term, area };
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

    const genericEnd = (w: string) =>
      /^(shop|store|cafe|center|centre|salon|hospital|bank|restaurant|company|companies|parlour|parlor|gym|hotel|clinic|pharmacy|services|service)$/i.test(
        w
      );

    const last = words[words.length - 1]!;
    if (genericEnd(last) && words.length < 3) return null;

    let candidate = last;
    if (genericEnd(last) && words.length >= 2) {
      candidate = words[words.length - 2]!;
    }
    if (!candidate || candidate.length < 3) return null;
    const bad = new Set(["near", "me", "for", "and", "the", "best", "top", "all"]);
    if (bad.has(candidate.toLowerCase())) return null;
    return candidate;
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
    termForInference: string
  ): Promise<SearchOrigin> => {
    const area = areaFromQuery.trim();
    if (area) {
      setFromLocationText(area);
      setUsingDeviceLocation(false);
      const coords = await geocodeAddress(area);
      return { coords, areaHint: area };
    }

    if (usingDeviceLocation) {
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
        // fall through to GPS / error
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
    areaHint?: string
  ): Promise<{ places: Place[]; expanded: boolean }> => {
    const response = await fetch(
      `/api/places/nearby?` +
        new URLSearchParams({
          query: term,
          lat: String(location.lat),
          lng: String(location.lng),
          radius: String(selectedRadius),
          area: areaHint ?? fromLocationText,
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

  const runSearch = async (term: string, selectedRadius: number) => {
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
      return;
    }

    setIsLoading(true);
    setStatus("Finding your search location…");

    try {
      const { coords: location, areaHint: resolvedAreaHint } = await resolveLocationForSearch(
        effectiveArea,
        effectiveTerm
      );
      setUserLocation(location);
      setStatus(`Searching “${effectiveTerm}” within ${formatDistance(selectedRadius)}…`);

      let effectiveRadius = selectedRadius;
      // Never pass GPS label into Places text query — only explicit area / From / resolved city.
      const areaHint =
        resolvedAreaHint || effectiveArea || fromLocationText.trim();
      let expandedAny = false;
      let { places: foundPlaces, expanded } = await fetchNearbyWithinRadius(
        effectiveTerm,
        location,
        selectedRadius,
        areaHint
      );
      if (expanded) expandedAny = true;

      if (foundPlaces.length === 0) {
        for (const stepRadius of EXPAND_STEPS_METERS) {
          if (stepRadius <= selectedRadius) continue;
          setStatus(
            `No matches in ${formatDistance(effectiveRadius)}. Trying ${formatDistance(stepRadius)}…`
          );
          const next = await fetchNearbyWithinRadius(
            effectiveTerm,
            location,
            stepRadius,
            areaHint
          );
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
    } catch (error) {
      const message = error instanceof Error ? error.message : "Something went wrong.";
      setStatus(message);
      setStatusTone("error");
      setPlaces([]);
      setAllPlaces([]);
      setSelectedPlaceId(null);
      setResultsExpanded(false);
    } finally {
      setIsLoading(false);
    }
  };

  const showCompetitorsFromCurrentList = () => {
    if (allPlaces.length === 0) {
      setStatus("Run a search first to load results, then filter competitors.");
      setStatusTone("warn");
      return;
    }

    const filtered = allPlaces.filter((place) =>
      COMPETITOR_HINT_PATTERN.test(`${place.name} ${place.address}`)
    );

    setPlaces(filtered);
    setSelectedPlaceId(filtered[0]?.id ?? null);
    setStatusTone(filtered.length > 0 ? "success" : "warn");
    setStatus(
      filtered.length > 0
        ? `${filtered.length} competitor-style match(es) from your list.`
        : "No competitor-style rows in the current list."
    );
  };

  const showAllFromCurrentList = () => {
    setPlaces(allPlaces);
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

  const onSearchKeyDown = useCallback((event: React.KeyboardEvent) => {
    if (event.key === "Escape") setShowSuggestions(false);
  }, []);

  return (
    <section className="nearby-shell">
      <div className="control-card">
        <div className="control-card-header">
          <div>
            <p className="control-card-title">Search</p>
            <p className="control-card-hint">
              Tap <strong>Use my location</strong> — your area appears in <strong>From</strong>, then
              search <strong>spa</strong>, <strong>hotel</strong>, etc. near you. Or put the city in
              the search: <strong>cafe in Raipur</strong>, <strong>salon, Mumbai</strong>.
            </p>
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
            onClick={showCompetitorsFromCurrentList}
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
      </div>

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
        </div>

        <aside className="results-panel">
          <div className="results-panel-header">
            <h2>Results</h2>
            <p className="results-meta">
              {places.length} {places.length === 1 ? "place" : "places"}
              {resultsExpanded ? " · includes nearest outside strict radius" : ""}
            </p>
          </div>
          <div className="results-list">
            {places.length === 0 ? (
              <div className="result-empty">
                {hasSearched
                  ? "No rows for this search. Try a different keyword, widen radius, or add an area (e.g. “in Mumbai”)."
                  : "Run a search to see a ranked list with distance and rating."}
              </div>
            ) : (
              places.map((place, index) => (
                <button
                  key={place.id}
                  type="button"
                  className={`result-card ${selectedPlaceId === place.id ? "active" : ""}`}
                  onClick={() => setSelectedPlaceId(place.id)}
                >
                  <span className="result-index">{index + 1}</span>
                  <p className="result-title">{place.name}</p>
                  <p className="result-address">{place.address}</p>
                  <div className="result-footer">
                    <span className="badge badge-distance">{formatDistance(place.distanceMeters)}</span>
                    <span className="badge badge-rating">★ {ratingLabel(place.rating)}</span>
                  </div>
                </button>
              ))
            )}
          </div>
        </aside>
      </div>
    </section>
  );
}
