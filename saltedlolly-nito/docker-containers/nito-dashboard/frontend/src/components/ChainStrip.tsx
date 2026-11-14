import { useLayoutEffect, useRef, useState } from "react";
import type { Block } from "../api.js";
import { clock, formatBytes, formatNumber, timeAgo } from "../format.js";
import { useNow, useReducedMotion } from "../hooks.js";

// Blocks kept in the row: more than fit, so the oldest slide out of view
// (the row is right-aligned and clipped on the left)
const SHOWN = 12;
// More new blocks than this at once (catching up) just appear
const MAX_ANIMATED = 4;
const SLIDE_MS = 900;
const FRESH_MS = 2600;
const TARGET_SECONDS = 60;

export function ChainStrip({ blocks }: { blocks: Block[] }) {
  const now = useNow(1000);
  const reduced = useReducedMotion();
  const rowRef = useRef<HTMLDivElement>(null);
  const lastTip = useRef<Block | null>(null);
  const [fresh, setFresh] = useState<Set<string>>(new Set());

  const shown = blocks.slice(-SHOWN);
  const tip = shown[shown.length - 1] ?? null;

  // When new blocks arrive, start the row shifted right by the number of new
  // blocks (so everything sits where it was) and slide it into place
  useLayoutEffect(() => {
    const previous = lastTip.current;
    lastTip.current = tip;
    const row = rowRef.current;
    if (!tip || !previous || !row || tip.hash === previous.hash) return;
    const added = tip.height - previous.height;
    if (added <= 0 || added > MAX_ANIMATED) return;
    const newHashes = shown.slice(-added).map((block) => block.hash);
    setFresh(new Set(newHashes));
    const timer = setTimeout(() => setFresh(new Set()), FRESH_MS);
    if (!reduced) {
      row.style.transition = "none";
      row.style.transform = `translateX(calc(${added} * var(--slot)))`;
      row.getBoundingClientRect(); // apply the start position before animating
      row.style.transition = `transform ${SLIDE_MS}ms cubic-bezier(0.2, 0.8, 0.2, 1)`;
      row.style.transform = "translateX(0)";
    }
    return () => clearTimeout(timer);
  }, [tip?.hash]);

  const intervals = blocks.slice(1).map((block, i) => block.time - blocks[i].time);
  const average = intervals.length ? intervals.reduce((a, b) => a + b, 0) / intervals.length : null;
  const sinceTip = tip ? now / 1000 - tip.time : 0;

  return (
    <section className="hero chain-hero" aria-label="Latest blocks">
      <div className="hero-head">
        <h2>Latest blocks</h2>
        <p className="hero-note">
          A new Nito block is found about once a minute
          {average !== null && intervals.length >= 5 && (
            <>
              {" "}
              · last {intervals.length + 1} blocks averaged <strong>{Math.round(average)}s</strong>
            </>
          )}
        </p>
      </div>
      <div className="chain">
        <div className="chain-viewport">
          <div className="chain-row" ref={rowRef}>
            {shown.map((block) => (
              <article
                key={block.hash}
                className={`block ${block === tip ? "block-tip" : ""} ${fresh.has(block.hash) ? "block-fresh" : ""}`}
                title={`Block ${formatNumber(block.height)}\n${block.hash}`}
              >
                <div className="block-face">
                  <div className="block-height">{formatNumber(block.height)}</div>
                  <div className="block-meta">
                    <span>{timeAgo(now / 1000 - block.time)}</span>
                    <span>
                      {formatNumber(block.transactions)} tx{block.transactions === 1 ? "" : "s"}
                    </span>
                    <span>{formatBytes(block.size)}</span>
                  </div>
                </div>
              </article>
            ))}
          </div>
        </div>
        <div className={`block-next ${sinceTip > TARGET_SECONDS * 3 ? "block-next-late" : ""}`} aria-live="off">
          <div className="block-next-label">Next block</div>
          <div className="block-next-timer">{tip ? clock(sinceTip) : "–"}</div>
          <div className="block-next-sub">since the last one</div>
        </div>
      </div>
    </section>
  );
}
