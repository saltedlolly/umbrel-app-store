import { useEffect, useState } from "react";
import type { Fact } from "../api.js";

const SHOW_MS = 60_000;

// The fact's link: made clickable where the text already mentions it,
// otherwise added as "Find out more"
function FactText({ fact }: { fact: Fact }) {
  const link = (text: string) => (
    <a href={fact.url!} target="_blank" rel="noopener noreferrer">
      {text}
    </a>
  );
  if (!fact.url) return <>{fact.content}</>;
  const at = fact.content.indexOf(fact.url);
  if (at >= 0) {
    return (
      <>
        {fact.content.slice(0, at)}
        {link(fact.url)}
        {fact.content.slice(at + fact.url.length)}
      </>
    );
  }
  return (
    <>
      {fact.content} {link("Find out more")}
    </>
  );
}

// One NitoFact at a time, moving on every 60 seconds. Starts at a random fact
// so each visit shows something different.
export function NitoFacts({ facts }: { facts: Fact[] | null }) {
  const count = facts?.length ?? 0;
  const [index, setIndex] = useState<number | null>(null);
  // Bumped on prev/next so the 60 seconds start again
  const [turn, setTurn] = useState(0);

  useEffect(() => {
    if (count && index === null) setIndex(Math.floor(Math.random() * count));
  }, [count, index]);

  useEffect(() => {
    if (!count) return;
    const timer = setInterval(() => setIndex((i) => ((i ?? 0) + 1) % count), SHOW_MS);
    return () => clearInterval(timer);
  }, [count, turn]);

  if (!facts || !count || index === null) return null;
  const fact = facts[index % count];

  function step(by: number) {
    setIndex((i) => (((i ?? 0) + by) % count + count) % count);
    setTurn((t) => t + 1);
  }

  return (
    <section className="panel facts" aria-label="NitoFacts">
      <div className="chart-head facts-head">
        <h2>Did you know?</h2>
        <span className="chart-sub">
          NitoFact #{fact.number} of {count}
        </span>
        <span className="facts-nav">
          <button type="button" className="button-outline" onClick={() => step(-1)} aria-label="Previous fact">
            ‹
          </button>
          <button type="button" className="button-outline" onClick={() => step(1)} aria-label="Next fact">
            ›
          </button>
        </span>
      </div>
      <p className="fact" key={fact.number} aria-live="polite">
        <FactText fact={fact} />
      </p>
    </section>
  );
}
