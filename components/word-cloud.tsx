"use client";

import { useState } from "react";
import type { WordCount } from "@/lib/wordclouds";

const MIN_REM = 1.25;
const MAX_REM = 5;

/** Font size in rem, scaled linearly between the least and most frequent word. */
export function wordSize(count: number, min: number, max: number, minRem = MIN_REM, maxRem = MAX_REM) {
  if (max === min) return (minRem + maxRem) / 2;
  return minRem + ((count - min) / (max - min)) * (maxRem - minRem);
}

/** Words sized by frequency. Size is not the only cue: hovering or focusing a word shows its count, and a text list follows. */
export function WordCloud({ words, sizeRange }: { words: WordCount[]; sizeRange?: [number, number] }) {
  const [active, setActive] = useState<string | null>(null);
  if (words.length === 0) return <p className="present-empty">No words yet</p>;
  const counts = words.map((w) => w.count);
  const min = Math.min(...counts);
  const max = Math.max(...counts);
  return (
    <>
      <ul
        aria-label="Word cloud"
        className="word-cloud"
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
            data-top={w.count === max && max > min ? true : undefined}
            style={{ fontSize: `${wordSize(w.count, min, max, sizeRange?.[0], sizeRange?.[1])}rem` }}
          >
            {w.word}
            {active === w.word && <sup>×{w.count}</sup>}
          </li>
        ))}
      </ul>
      <ul aria-label="Word counts" className="sr-only">
        {words.map((w) => (
          <li key={w.word}>
            {w.word}: {w.count}
          </li>
        ))}
      </ul>
    </>
  );
}
