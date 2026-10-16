"use client";

import { useState } from "react";
import type { WordCount } from "@/lib/wordclouds";

const MIN_REM = 1.25;
const MAX_REM = 5;

const srOnly = { position: "absolute", width: 1, height: 1, overflow: "hidden", clip: "rect(0 0 0 0)" } as const;

/** Font size in rem, scaled linearly between the least and most frequent word. */
export function wordSize(count: number, min: number, max: number) {
  if (max === min) return (MIN_REM + MAX_REM) / 2;
  return MIN_REM + ((count - min) / (max - min)) * (MAX_REM - MIN_REM);
}

/** Words sized by frequency. Size is not the only cue: hovering or focusing a word shows its count, and a text list follows. */
export function WordCloud({ words }: { words: WordCount[] }) {
  const [active, setActive] = useState<string | null>(null);
  if (words.length === 0) return <p style={{ fontSize: "2rem" }}>No words yet</p>;
  const counts = words.map((w) => w.count);
  const min = Math.min(...counts);
  const max = Math.max(...counts);
  return (
    <>
      <ul
        aria-label="Word cloud"
        style={{ listStyle: "none", padding: 0, margin: 0, display: "flex", flexWrap: "wrap", gap: "8px 24px", alignItems: "baseline" }}
      >
        {words.map((w) => (
          <li
            key={w.word}
            tabIndex={0}
            aria-label={`${w.word}, ${w.count} ${w.count === 1 ? "entry" : "entries"}`}
            onMouseEnter={() => setActive(w.word)}
            onMouseLeave={() => setActive(null)}
            onFocus={() => setActive(w.word)}
            onBlur={() => setActive(null)}
            style={{ fontSize: `${wordSize(w.count, min, max)}rem`, fontWeight: 700, lineHeight: 1.1 }}
          >
            {w.word}
            {active === w.word && <sup style={{ fontSize: "1.25rem", marginLeft: 4 }}>×{w.count}</sup>}
          </li>
        ))}
      </ul>
      <ul aria-label="Word counts" style={srOnly}>
        {words.map((w) => (
          <li key={w.word}>
            {w.word}: {w.count}
          </li>
        ))}
      </ul>
    </>
  );
}
