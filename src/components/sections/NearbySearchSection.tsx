"use client";

import dynamic from "next/dynamic";
import { FormEvent, useMemo, useState } from "react";
import { formatDistance, haversineDistanceMeters } from "@/lib/distance";
import type { Place, UserLocation } from "@/types/place";

const NearbyMap = dynamic(() => import("@/components/sections/NearbyMap"), {
  ssr: false,
});

const DEFAULT_RADIUS_METERS = 5000;
const RADIUS_OPTIONS = [5000, 10000, 15000, 20000, 30000] as const;
const AUTO_EXPAND_BASE_STEPS = [5000, 10000, 20000, 30000];

function mapGooglePlaceToPlace(
  item: google.maps.places.PlaceResult,
  userLocation: UserLocation
): Place | null {
  const lat = item.geometry?.location?.lat();
  const lon = item.geometry?.location?.lng();

  if (typeof lat !== "number" || typeof lon !== "number") return null;

  return {
    id: item.place_id ?? `${lat}-${lon}`,
    name: item.name?.trim() || "Unnamed place",
    address: item.vicinity?.trim() || item.formatted_address?.trim() || "Address unavailable",
    lat,
    lon,
    distanceMeters: haversineDistanceMeters(userLocation.lat, userLocation.lng, lat, lon),
    rating: typeof item.rating === "number" ? item.rating : undefined,
  };
}

export default function NearbySearchSection() {
  const [query, setQuery] = useState("salon");
  const [radiusMeters, setRadiusMeters] = useState<number>(DEFAULT_RADIUS_METERS);
  const [customRadiusKm, setCustomRadiusKm] = useState<string>("5");
  const [userLocation, setUserLocation] = useState<UserLocation | null>(null);
  const [places, setPlaces] = useState<Place[]>([]);
  const [selectedPlaceId, setSelectedPlaceId] = useState<string | null>(null);
  const [status, setStatus] = useState<string>("Search for a place near you.");
  const [isLoading, setIsLoading] = useState(false);

  const effectiveCenter = useMemo<UserLocation>(
    () => userLocation ?? { lat: 20.5937, lng: 78.9629 },
    [userLocation]
  );

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

  const loadGooglePlacesApi = async (): Promise<typeof google> => {
    if (typeof window === "undefined") {
      throw new Error("Google Maps can only run in browser.");
    }

    if (window.google?.maps?.places) return window.google;

    const apiKey = process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY;
    if (!apiKey) {
      throw new Error("Missing NEXT_PUBLIC_GOOGLE_MAPS_API_KEY.");
    }

    await new Promise<void>((resolve, reject) => {
      const existing = document.getElementById("google-maps-script");
      if (existing) {
        existing.addEventListener("load", () => resolve(), { once: true });
        existing.addEventListener("error", () => reject(new Error("Failed to load Google Maps.")), {
          once: true,
        });
        return;
      }

      const script = document.createElement("script");
      script.id = "google-maps-script";
      script.src =
        "https://maps.googleapis.com/maps/api/js?" +
        new URLSearchParams({
          key: apiKey,
          libraries: "places",
        }).toString();
      script.async = true;
      script.defer = true;
      script.onload = () => resolve();
      script.onerror = () => reject(new Error("Failed to load Google Maps."));
      document.head.appendChild(script);
    });

    if (!window.google?.maps?.places) {
      throw new Error("Google Places API is unavailable.");
    }

    return window.google;
  };

  const nearbySearchWithPagination = async (
    service: google.maps.places.PlacesService,
    request: google.maps.places.PlaceSearchRequest
  ): Promise<google.maps.places.PlaceResult[]> =>
    new Promise((resolve, reject) => {
      const allResults: google.maps.places.PlaceResult[] = [];

      service.nearbySearch(request, (results, status, pagination) => {
        if (
          status !== google.maps.places.PlacesServiceStatus.OK &&
          status !== google.maps.places.PlacesServiceStatus.ZERO_RESULTS
        ) {
          reject(new Error("Google Places request failed."));
          return;
        }

        if (results?.length) allResults.push(...results);

        if (pagination?.hasNextPage) {
          setTimeout(() => pagination.nextPage(), 2000);
          return;
        }

        resolve(allResults);
      });
    });

  const fetchNearbyWithinRadius = async (
    term: string,
    location: UserLocation,
    selectedRadius: number
  ): Promise<Place[]> => {
    const googleMaps = await loadGooglePlacesApi();
    const service = new googleMaps.maps.places.PlacesService(document.createElement("div"));
    const request: google.maps.places.PlaceSearchRequest = {
      location: new googleMaps.maps.LatLng(location.lat, location.lng),
      radius: selectedRadius,
      keyword: term,
    };

    const rawResults = await nearbySearchWithPagination(service, request);
    return rawResults
      .map((item) => mapGooglePlaceToPlace(item, location))
      .filter((item): item is Place => Boolean(item))
      .sort((a, b) => a.distanceMeters - b.distanceMeters);
  };

  const fetchGlobalMatches = async (term: string, location: UserLocation): Promise<Place[]> => {
    const googleMaps = await loadGooglePlacesApi();
    const service = new googleMaps.maps.places.PlacesService(document.createElement("div"));

    const progressivelyWider = [50000, 80000, 120000, 160000];
    const collected = new Map<string, Place>();

    for (const radius of progressivelyWider) {
      const request: google.maps.places.PlaceSearchRequest = {
        location: new googleMaps.maps.LatLng(location.lat, location.lng),
        radius,
        keyword: term,
      };
      const rawResults = await nearbySearchWithPagination(service, request);
      const mapped = rawResults
        .map((item) => mapGooglePlaceToPlace(item, location))
        .filter((item): item is Place => Boolean(item));
      mapped.forEach((item) => collected.set(item.id, item));
      if (collected.size >= 60) break;
    }

    return [...collected.values()].sort((a, b) => a.distanceMeters - b.distanceMeters);
  };

  const getExpandedRadiusSequence = (startRadius: number): number[] => {
    const sequence = new Set<number>([startRadius, ...AUTO_EXPAND_BASE_STEPS]);
    let nextRadius = 40000;

    // No fixed upper limit in UX; this keeps requesting wider ranges progressively.
    while (sequence.size < 20) {
      sequence.add(nextRadius);
      nextRadius += 10000;
    }

    return [...sequence].sort((a, b) => a - b).filter((value) => value >= startRadius);
  };

  const runSearch = async (term: string, selectedRadius: number) => {
    if (!term.trim()) return;

    setIsLoading(true);
    setStatus("Detecting your location...");

    try {
      const location = await requestCurrentLocation();
      setUserLocation(location);
      const expandedRadii = getExpandedRadiusSequence(selectedRadius);
      let foundPlaces: Place[] = [];
      let matchedRadius = selectedRadius;

      for (const radius of expandedRadii) {
        setStatus(`Searching "${term}" within ${formatDistance(radius)}...`);
        const currentResults = await fetchNearbyWithinRadius(term, location, radius);
        if (currentResults.length > 0) {
          foundPlaces = currentResults;
          matchedRadius = radius;
          break;
        }
      }

      if (foundPlaces.length === 0) {
        setStatus(`Expanding search globally for "${term}"...`);
        foundPlaces = await fetchGlobalMatches(term, location);
      }

      const uniqueById = new Map(foundPlaces.map((place) => [place.id, place]));
      const sortedPlaces = [...uniqueById.values()].sort(
        (a, b) => a.distanceMeters - b.distanceMeters
      );

      if (sortedPlaces.length > 0) {
        setRadiusMeters(Math.max(selectedRadius, matchedRadius));
      }

      setPlaces(sortedPlaces);
      setSelectedPlaceId(sortedPlaces[0]?.id ?? null);
      setStatus(
        sortedPlaces.length > 0
          ? `${sortedPlaces.length} place(s) found using Google Maps. Nearest first.`
          : `No matching Google Maps data available for "${term}".`
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
        <input
          className="search-input"
          type="text"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder='Search service, e.g. "salon"'
        />
        <button className="search-button" type="submit" disabled={isLoading}>
          {isLoading ? "Searching..." : "Search"}
        </button>
      </form>

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
        </div>

        <aside className="results-panel">
          <h2>Nearby Results</h2>
          <p>{places.length} found</p>
          <div className="results-list">
            {places.length === 0 ? (
              <div className="result-empty">
                No nearby places yet. Try searching &quot;salon&quot;.
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
