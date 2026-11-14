import { useMemo, useState } from "react";
import { geoArea, geoCentroid, geoEqualEarth, geoPath } from "d3-geo";
import { feature } from "topojson-client";
import type { Feature, FeatureCollection, Geometry, MultiPolygon, Polygon } from "geojson";
import type { GeometryCollection, Topology } from "topojson-specification";
import countries from "i18n-iso-countries";
import world from "world-atlas/countries-110m.json";
import type { Peers } from "../api.js";
import { useWidth } from "../hooks.js";

type Country = Feature<Polygon | MultiPolygon, { name: string }>;

const topology = world as unknown as Topology<{ countries: GeometryCollection<{ name: string }> }>;
const land = (feature(topology, topology.objects.countries) as FeatureCollection<Geometry, { name: string }>).features
  .filter((f) => f.id !== "010") // Antarctica
  .filter((f): f is Country => f.geometry?.type === "Polygon" || f.geometry?.type === "MultiPolygon");
const byNumeric = new Map(land.map((f) => [String(f.id), f]));

const names = (() => {
  try {
    return new Intl.DisplayNames(undefined, { type: "region" });
  } catch {
    return null;
  }
})();

function countryName(code: string): string {
  try {
    return names?.of(code) ?? code;
  } catch {
    return code;
  }
}

// The middle of a country's largest piece of land (so France's dot sits in
// France, not out in the Atlantic between it and French Guiana)
function mainCentroid(country: Country): [number, number] {
  if (country.geometry.type === "Polygon") return geoCentroid(country);
  let best: Polygon | null = null;
  let bestArea = -1;
  for (const coordinates of country.geometry.coordinates) {
    const polygon: Polygon = { type: "Polygon", coordinates };
    const area = geoArea(polygon);
    if (area > bestArea) {
      bestArea = area;
      best = polygon;
    }
  }
  return geoCentroid(best ?? country);
}

export function PeerMap({ peers }: { peers: Peers | null }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<string | null>(null);
  const height = Math.round(width * 0.5);

  const { path, projection } = useMemo(() => {
    const projection = geoEqualEarth().fitSize([Math.max(1, width), Math.max(1, height)], {
      type: "FeatureCollection",
      features: land,
    });
    return { path: geoPath(projection), projection };
  }, [width, height]);

  const located = (peers?.countries ?? []).map((c) => {
    const numeric = countries.alpha2ToNumeric(c.code);
    const shape = numeric ? byNumeric.get(numeric) : undefined;
    return { ...c, shape, name: countryName(c.code) };
  });
  const peersByNumeric = new Map(located.filter((c) => c.shape).map((c) => [String(c.shape!.id), c]));
  const most = Math.max(1, ...located.map((c) => c.peers));
  const hovered = located.find((c) => c.code === hover) ?? null;

  return (
    <section className="panel peer-map" aria-label="Where your peers are">
      <div className="chart-head">
        <h2>Connected peers</h2>
        <span className="chart-sub">
          {peers ? `${peers.total} node${peers.total === 1 ? "" : "s"} · ${peers.inbound} in · ${peers.outbound} out` : "Loading…"}
        </span>
      </div>
      <div className="map" ref={ref}>
        {width > 0 && (
          <svg width={width} height={height} role="img" aria-label="World map of the countries your peers are in" onMouseLeave={() => setHover(null)}>
            {land.map((shape) => {
              const country = peersByNumeric.get(String(shape.id));
              return (
                <path
                  key={String(shape.id)}
                  d={path(shape) ?? ""}
                  className={country ? "land land-peers" : "land"}
                  style={country ? { fillOpacity: 0.35 + 0.55 * (country.peers / most) } : undefined}
                  onMouseEnter={() => setHover(country ? country.code : null)}
                  onClick={() => setHover(country ? country.code : null)}
                />
              );
            })}
            {located
              .filter((c) => c.shape)
              .map((c) => {
                const point = projection(mainCentroid(c.shape!));
                if (!point) return null;
                const r = 3 + 2.2 * Math.sqrt(c.peers);
                return (
                  <g key={c.code} className={`peer-dot ${hover === c.code ? "peer-dot-hover" : ""}`}>
                    <circle className="peer-pulse" cx={point[0]} cy={point[1]} r={r} />
                    <circle className="peer-core" cx={point[0]} cy={point[1]} r={r} onMouseEnter={() => setHover(c.code)} />
                  </g>
                );
              })}
          </svg>
        )}
        {hovered && (
          <div className="map-tip">
            <strong>{hovered.name}</strong> {hovered.peers} peer{hovered.peers === 1 ? "" : "s"}
          </div>
        )}
      </div>
      {peers && (
        <ul className="peer-list">
          {located.map((c) => (
            <li key={c.code} onMouseEnter={() => setHover(c.code)} onMouseLeave={() => setHover(null)}>
              <span className="peer-swatch" aria-hidden="true" />
              <span className="peer-name">{c.name}</span>
              <span className="peer-count">{c.peers}</span>
            </li>
          ))}
          {peers.notLocated > 0 && (
            <li className="peer-unlocated" title="Peers connected over Tor or I2P, or from private addresses, can't be placed on a map">
              <span className="peer-swatch" aria-hidden="true" />
              <span className="peer-name">Not located (Tor or private)</span>
              <span className="peer-count">{peers.notLocated}</span>
            </li>
          )}
          {peers.total === 0 && <li className="peer-none">No peers connected yet.</li>}
        </ul>
      )}
    </section>
  );
}
