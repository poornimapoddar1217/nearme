"use client";

import "leaflet/dist/leaflet.css";
import { useEffect, useMemo } from "react";
import {
  Circle,
  MapContainer,
  Marker,
  Popup,
  TileLayer,
  useMap,
} from "react-leaflet";
import L from "leaflet";
import type { Place, UserLocation } from "@/types/place";
import { formatDistance } from "@/lib/distance";

type NearbyMapProps = {
  center: UserLocation;
  places: Place[];
  radiusMeters: number;
  selectedPlaceId: string | null;
  onSelectPlace: (placeId: string) => void;
};

function MapViewUpdater({ center, radiusMeters }: { center: UserLocation; radiusMeters: number }) {
  const map = useMap();
  const zoom = radiusMeters <= 1000 ? 15 : radiusMeters <= 3000 ? 14 : 13;
  map.setView([center.lat, center.lng], zoom);
  return null;
}

function FocusSelectedMarker({
  places,
  selectedPlaceId,
}: {
  places: Place[];
  selectedPlaceId: string | null;
}) {
  const map = useMap();
  useEffect(() => {
    if (!selectedPlaceId) return;
    const selected = places.find((item) => item.id === selectedPlaceId);
    if (!selected) return;

    map.flyTo([selected.lat, selected.lon], Math.max(map.getZoom(), 16), {
      duration: 0.6,
    });
  }, [map, places, selectedPlaceId]);

  return null;
}

function createMarkerIcon(className: string): L.DivIcon {
  return L.divIcon({
    className,
    html: "<span></span>",
    iconSize: [22, 22],
    iconAnchor: [11, 11],
  });
}

export default function NearbyMap({
  center,
  places,
  radiusMeters,
  selectedPlaceId,
  onSelectPlace,
}: NearbyMapProps) {
  const userIcon = useMemo(() => createMarkerIcon("map-user-marker"), []);
  const redPlaceIcon = useMemo(() => createMarkerIcon("map-place-marker"), []);

  return (
    <MapContainer center={[center.lat, center.lng]} zoom={15} className="map-root" zoomControl>
      <TileLayer
        attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
        url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
      />

      <MapViewUpdater center={center} radiusMeters={radiusMeters} />
      <FocusSelectedMarker places={places} selectedPlaceId={selectedPlaceId} />

      <Circle
        center={[center.lat, center.lng]}
        radius={radiusMeters}
        pathOptions={{ color: "var(--color-accent)", fillOpacity: 0.08, weight: 1.5 }}
      />

      <Marker position={[center.lat, center.lng]} icon={userIcon}>
        <Popup>You are here</Popup>
      </Marker>

      {places.map((place) => {
        const isSelected = selectedPlaceId === place.id;
        const markerIcon = isSelected
          ? createMarkerIcon("map-place-marker selected")
          : redPlaceIcon;

        return (
          <Marker
            key={place.id}
            position={[place.lat, place.lon]}
            icon={markerIcon}
            eventHandlers={{ click: () => onSelectPlace(place.id) }}
          >
            <Popup>
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
            </Popup>
          </Marker>
        );
      })}
    </MapContainer>
  );
}
