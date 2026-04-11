import NearbySearchSection from "@/components/sections/NearbySearchSection";

export default function HomePage() {
  return (
    <main className="page-root">
      <header className="page-header">
        <h1>Near Me</h1>
        <p>
          Search for any place or service, see it on the map, and browse a clean list sorted by
          distance with ratings.
        </p>
      </header>
      <NearbySearchSection />
    </main>
  );
}
