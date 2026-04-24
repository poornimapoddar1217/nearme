export type Place = {
  id: string;
  name: string;
  address: string;
  lat: number;
  lon: number;
  distanceMeters: number;
  rating?: number;
  reviewLink?: string;
  socialLink?: string;
};

export type UserLocation = {
  lat: number;
  lng: number;
};
