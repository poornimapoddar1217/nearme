export type Place = {
  id: string;
  name: string;
  address: string;
  lat: number;
  lon: number;
  distanceMeters: number;
  rating?: number;
};

export type UserLocation = {
  lat: number;
  lng: number;
};
