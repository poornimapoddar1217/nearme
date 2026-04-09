"use client";

import dynamic from "next/dynamic";
import { FormEvent, useEffect, useMemo, useState } from "react";
import { formatDistance } from "@/lib/distance";
import type { Place, UserLocation } from "@/types/place";

const NearbyMap = dynamic(() => import("@/components/sections/NearbyMap"), {
  ssr: false,
});

const DEFAULT_RADIUS_METERS = 5000;
const RADIUS_OPTIONS = [5000, 10000, 15000, 20000, 30000] as const;
const EXPAND_STEPS_METERS = [10000, 20000, 30000, 50000, 80000, 120000, 180000, 250000];

export default function NearbySearchSection() {
  const [query, setQuery] = useState("");
  const [fromLocationText, setFromLocationText] = useState("");
  const [suggestions, setSuggestions] = useState<Array<{ id: string; label: string }>>([]);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [radiusMeters, setRadiusMeters] = useState<number>(DEFAULT_RADIUS_METERS);
  const [customRadiusKm, setCustomRadiusKm] = useState<string>("5");
  const [userLocation, setUserLocation] = useState<UserLocation | null>(null);
  const [places, setPlaces] = useState<Place[]>([]);
  const [selectedPlaceId, setSelectedPlaceId] = useState<string | null>(null);
  const [locationDescription, setLocationDescription] = useState<string>("");
  const [hasSearched, setHasSearched] = useState(false);
  const [status, setStatus] = useState<string>(
    "Enter To service and From location, then search."
  );
  const [isLoading, setIsLoading] = useState(false);

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
        const body = (await response.json()) as {
          suggestions?: Array<{ id: string; label: string }>;
        };
        setSuggestions(body.suggestions ?? []);
      } catch {
        setSuggestions([]);
      }
    }, 250);

    return () => clearTimeout(timer);
  }, [query]);

  const parseQueryAndArea = (input: string): { term: string; area: string } => {
    const value = input.trim();
    const parts = value.split(/\s+in\s+/i);
    if (parts.length > 1) {
      const area = parts.pop()?.trim() ?? "";
      const term = parts.join(" in ").trim();
      return { term, area };
    }
    return { term: value, area: "" };
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
        { enableHighAccuracy: true, timeout: 12000 }
      );
    });

  const resolveLocation = async (fromOverride?: string): Promise<UserLocation> => {
    const fromText = (fromOverride ?? fromLocationText).trim();
    if (fromText) {
      const response = await fetch(
        `/api/places/geocode?` +
          new URLSearchParams({
            address: fromText,
          }).toString()
      );
      if (!response.ok) {
        const body = (await response.json()) as { error?: string };
        throw new Error(body.error ?? "Could not resolve From location.");
      }
      const body = (await response.json()) as {
        lat: number;
        lng: number;
        formattedAddress?: string;
      };
      setLocationDescription(body.formattedAddress ?? fromText);
      return { lat: body.lat, lng: body.lng };
    }

    if (userLocation) {
      setLocationDescription("Current device location");
      return userLocation;
    }

    throw new Error(
      "Add From location, or click Use Current Location before searching."
    );
  };

  const fetchNearbyWithinRadius = async (
    term: string,
    location: UserLocation,
    selectedRadius: number
  ): Promise<Place[]> => {
    const response = await fetch(
      `/api/places/nearby?` +
        new URLSearchParams({
          query: term,
          lat: String(location.lat),
          lng: String(location.lng),
          radius: String(selectedRadius),
        }).toString()
    );

    if (!response.ok) {
      throw new Error("Nearby search failed. Please try again.");
    }

    const body = (await response.json()) as { places?: Place[]; error?: string };
    if (!body.places) {
      throw new Error(body.error ?? "No place data returned.");
    }

    return body.places.sort((a, b) => a.distanceMeters - b.distanceMeters);
  };

  const runSearch = async (term: string, selectedRadius: number) => {
    setHasSearched(true);
    setShowSuggestions(false);

    const parsed = parseQueryAndArea(term);
    const effectiveTerm = parsed.term;
    const effectiveArea = parsed.area;

    if (!effectiveTerm.trim()) {
      setStatus("Please enter what you want to search (e.g. cafe, medical shop).");
      return;
    }

    setIsLoading(true);
    setStatus("Resolving location...");

    try {
      if (effectiveArea) {
        setFromLocationText(effectiveArea);
      }
      const location = await resolveLocation(effectiveArea || undefined);
      setUserLocation(location);
      setStatus(`Searching "${effectiveTerm}" within ${formatDistance(selectedRadius)}...`);
      let effectiveRadius = selectedRadius;
      let foundPlaces = await fetchNearbyWithinRadius(effectiveTerm, location, selectedRadius);

      if (foundPlaces.length === 0) {
        for (const stepRadius of EXPAND_STEPS_METERS) {
          if (stepRadius <= selectedRadius) continue;
          setStatus(
            `No result for "${effectiveTerm}" in ${formatDistance(
              effectiveRadius
            )}. Expanding search to ${formatDistance(stepRadius)}...`
          );
          foundPlaces = await fetchNearbyWithinRadius(effectiveTerm, location, stepRadius);
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

      setPlaces(sortedPlaces);
      setSelectedPlaceId(sortedPlaces[0]?.id ?? null);
      setStatus(
        sortedPlaces.length > 0
          ? `${sortedPlaces.length} "${effectiveTerm}" place(s) found in ${formatDistance(
              effectiveRadius
            )}. Sorted nearest first.`
          : `No "${effectiveTerm}" data found for this location right now. Try a broader keyword.`
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : "Something went wrong.";
      setStatus(message);
      setPlaces([]);
      setSelectedPlaceId(null);
    } finally {
      setIsLoading(false);
    }
  };

  const onSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    await runSearch(query, radiusMeters);
  };

  return (
    <section className="nearby-shell">
      <form className="toolbar" onSubmit={onSubmit}>
        <div className="search-wrap">
          <input
            className="search-input"
            type="text"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setShowSuggestions(true);
            }}
            onFocus={() => setShowSuggestions(true)}
            placeholder='Search anything, e.g. "it company in raipur"'
          />
          {showSuggestions && suggestions.length > 0 ? (
            <div className="suggestions-list">
              {suggestions.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  className="suggestion-item"
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
        <button className="search-button" type="submit" disabled={isLoading}>
          {isLoading ? "Searching..." : "Search"}
        </button>
      </form>

      <div className="from-row">
        <input
          className="from-input"
          type="text"
          value={fromLocationText}
          onChange={(event) => setFromLocationText(event.target.value)}
          placeholder='From location (address/area), e.g. "Pune, Maharashtra"'
        />
        <button
          className="location-button"
          type="button"
          disabled={isLoading}
          onClick={async () => {
            try {
              setStatus("Detecting current location...");
              const current = await requestCurrentLocation();
              setUserLocation(current);
              setFromLocationText("");
              setLocationDescription("Current device location");
              setStatus("Current location captured. Now search.");
            } catch {
              setStatus("Current location is blocked. Enter From location manually.");
            }
          }}
        >
          Use Current Location
        </button>
      </div>

      <div className="radius-row">
        {RADIUS_OPTIONS.map((value) => (
          <button
            key={value}
            type="button"
            className={`radius-pill ${radiusMeters === value ? "active" : ""}`}
            onClick={() => {
              setRadiusMeters(value);
              if (userLocation) void runSearch(query, value);
            }}
          >
            {value / 1000} km
          </button>
        ))}
        <label className="radius-custom">
          <span>Custom km</span>
          <input
            type="number"
            min="1"
            step="1"
            value={customRadiusKm}
            onChange={(event) => setCustomRadiusKm(event.target.value)}
            onBlur={() => {
              const parsedKm = Number(customRadiusKm);
              if (!Number.isFinite(parsedKm) || parsedKm <= 0) return;
              const customMeters = Math.round(parsedKm * 1000);
              setRadiusMeters(customMeters);
              if (userLocation) void runSearch(query, customMeters);
            }}
          />
        </label>
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
          <div className="status-chip">{status}</div>
          {locationDescription ? (
            <div className="from-chip">From: {locationDescription}</div>
          ) : null}
        </div>

        <aside className="results-panel">
          <h2>Nearby Results</h2>
          <p>{places.length} found</p>
          <div className="results-list">
            {places.length === 0 ? (
              <div className="result-empty">
                {hasSearched
                  ? `No "${query || "place"}" found. Try keywords like "IT company", "software company", "cafe", "pharmacy".`
                  : 'Type and select a suggestion, then click Search.'}
              </div>
            ) : (
              places.map((place) => (
                <button
                  key={place.id}
                  type="button"
                  className={`result-card ${selectedPlaceId === place.id ? "active" : ""}`}
                  onClick={() => setSelectedPlaceId(place.id)}
                >
                  <strong>{place.name}</strong>
                  <span>{place.address}</span>
                  <small>{formatDistance(place.distanceMeters)} away</small>
                  <small>
                    Rating: {typeof place.rating === "number" ? place.rating.toFixed(1) : "N/A"}
                  </small>
                </button>
              ))
            )}
          </div>
        </aside>
      </div>
    </section>
  );
}
