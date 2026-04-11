"use client";

import { useEffect, useMemo, useState } from "react";
import {
  APIProvider,
  AdvancedMarker,
  InfoWindow,
  Map,
  Marker,
  Pin,
  useMap,
} from "@vis.gl/react-google-maps";
import type { Place, UserLocation } from "@/types/place";
import { formatDistance } from "@/lib/distance";

type NearbyMapProps = {
  center: UserLocation;
  places: Place[];
  radiusMeters: number;
  selectedPlaceId: string | null;
  onSelectPlace: (placeId: string) => void;
};

function zoomForRadius(radiusMeters: number): number {
  if (radiusMeters <= 1000) return 15;
  if (radiusMeters <= 5000) return 14;
  if (radiusMeters <= 15000) return 13;
  if (radiusMeters <= 30000) return 12;
  return 11;
}

function RadiusCircle({
  center,
  radiusMeters,
}: {
  center: UserLocation;
  radiusMeters: number;
}) {
  const map = useMap();

  useEffect(() => {
    if (!map) return;
    const circle = new google.maps.Circle({
      map,
      center: { lat: center.lat, lng: center.lng },
      radius: radiusMeters,
      strokeColor: "#e85d4c",
      strokeOpacity: 0.9,
      strokeWeight: 2,
      fillColor: "#e85d4c",
      fillOpacity: 0.12,
    });
    return () => circle.setMap(null);
  }, [center.lat, center.lng, map, radiusMeters]);

  return null;
}

export default function NearbyMap({
  center,
  places,
  radiusMeters,
  selectedPlaceId,
  onSelectPlace,
}: NearbyMapProps) {
  const apiKey = process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY ?? "";
  const mapId = process.env.NEXT_PUBLIC_GOOGLE_MAPS_MAP_ID;
  const useAdvancedMarkers = Boolean(mapId);
  const [openInfoId, setOpenInfoId] = useState<string | null>(null);

  const selectedPlace = useMemo(
    () => places.find((item) => item.id === selectedPlaceId) ?? null,
    [places, selectedPlaceId]
  );
  const mapCenter = selectedPlace
    ? { lat: selectedPlace.lat, lng: selectedPlace.lon }
    : { lat: center.lat, lng: center.lng };
  const zoom = zoomForRadius(radiusMeters);

  if (!apiKey) {
    return <div className="map-root">Missing map API key.</div>;
  }

  return (
    <APIProvider apiKey={apiKey}>
      <Map
        className="map-root"
        center={mapCenter}
        zoom={zoom}
        mapId={mapId}
        gestureHandling="greedy"
        disableDefaultUI={false}
      >
        <RadiusCircle center={center} radiusMeters={radiusMeters} />

        {useAdvancedMarkers ? (
          <AdvancedMarker position={{ lat: center.lat, lng: center.lng }}>
            <Pin
              background="#3b82f6"
              borderColor="#ffffff"
              glyphColor="#ffffff"
              scale={1.05}
            />
          </AdvancedMarker>
        ) : (
          <Marker position={{ lat: center.lat, lng: center.lng }} />
        )}

        {places.map((place) => {
          const isSelected = selectedPlaceId === place.id;

          if (useAdvancedMarkers) {
            return (
              <AdvancedMarker
                key={place.id}
                position={{ lat: place.lat, lng: place.lon }}
                onClick={() => {
                  onSelectPlace(place.id);
                  setOpenInfoId(place.id);
                }}
              >
            <Pin
              background="#e85d4c"
              borderColor="#ffffff"
              glyphColor="#ffffff"
              scale={isSelected ? 1.2 : 1}
            />
              </AdvancedMarker>
            );
          }

          return (
            <Marker
              key={place.id}
              position={{ lat: place.lat, lng: place.lon }}
              onClick={() => {
                onSelectPlace(place.id);
                setOpenInfoId(place.id);
              }}
            />
          );
        })}

        {openInfoId
          ? (() => {
              const place = places.find((item) => item.id === openInfoId);
              if (!place) return null;
              return (
                <InfoWindow
                  position={{ lat: place.lat, lng: place.lon }}
                  onCloseClick={() => setOpenInfoId(null)}
                >
                  <div>
                    <strong>{place.name}</strong>
                    <br />
                    {place.address}
                    <br />
                    {formatDistance(place.distanceMeters)} away
                    {typeof place.rating === "number" ? (
                      <>
                        <br />
                        Rating: {place.rating.toFixed(1)}
                      </>
                    ) : null}
                  </div>
                </InfoWindow>
              );
            })()
          : null}
      </Map>
    </APIProvider>
  );
}
