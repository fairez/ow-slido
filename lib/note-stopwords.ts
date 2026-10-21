/** Db-free stop word lists, safe to import from client components. */

/**
 * Indonesian function words that clutter a word cloud: conjunctions (kata sambung), prepositions,
 * determiners, common pronouns and particles. Words that carry feedback on their own stay out of the
 * list on purpose (tidak, kurang, belum, terlalu, perlu, lebih banyak/sedikit, ...).
 */
export const INDONESIAN_STOP_WORDS = new Set(
  (
    // conjunctions
    "dan atau tetapi tapi namun melainkan sedangkan sementara serta lalu kemudian lantas karena sebab jika jikalau kalau apabila bila agar supaya sehingga hingga sampai ketika saat sewaktu selagi sebelum sesudah setelah sambil seraya bahwa maka walaupun walau meskipun meski biarpun padahal seolah seakan daripada ataupun yakni yaitu ialah jadi " +
      // prepositions
      "di ke dari pada dalam untuk dengan oleh bagi tentang terhadap kepada antara atas sejak menuju demi tanpa sebagai seperti bagai menurut mengenai selama sepanjang sekitar per " +
      // determiners and relative
      "yang ini itu tersebut para sang si sebuah suatu " +
      // pronouns
      "saya aku kami kita kamu anda dia ia mereka kalian " +
      // auxiliaries, particles, fillers
      "ada adalah merupakan akan sudah telah sedang masih juga pun lah kah saja hanya sangat sekali banget bisa dapat deh sih dong kok nih tuh aja " +
      // common chat abbreviations
      "yg dgn utk dr krn tp sm dgn"
  ).split(" "),
);

/** English function words and filler, used by the frequency fallback and when cleaning AI keywords. */
export const ENGLISH_STOP_WORDS = new Set(
  "a about above after again all also am an and any are as at be because been before being below between both but by can could did do does doing down during each few for from further had has have having he her here hers him his how i if in into is it its just me more most my no nor not now of off on once only or other our out over own same she should so some such than that the their them then there these they this those through to too under until up very was we were what when where which while who whom why will with would you your yours really get got like one also still much many lot lots thing things need needs want make makes".split(
    " ",
  ),
);

export const isIndonesianStopWord = (word: string) => INDONESIAN_STOP_WORDS.has(word.toLowerCase());

/** The event languages that have a stop-word list. */
export type StopWordLocale = "en" | "id";

/** A text counts as mixed once it holds this many different stop words of the other language. */
export const MIXED_TEXT_MIN_WORDS = 2;

const LIST_BY_LOCALE: Record<StopWordLocale, ReadonlySet<string>> = {
  id: INDONESIAN_STOP_WORDS,
  en: ENGLISH_STOP_WORDS,
};

/**
 * The lists that apply to a text. Without a language both do. With one, its own list does, and the other
 * language's list joins it when the text is mixed (a Bahasa Indonesia note with an English sentence in it).
 * A single stray word from the other language ("the" in "The Jakarta Post") does not make a text mixed, and
 * words the two languages share never count towards it.
 */
export function stopWordLists(text: string, locale?: StopWordLocale): ReadonlySet<string>[] {
  if (!locale) return [INDONESIAN_STOP_WORDS, ENGLISH_STOP_WORDS];
  const own = LIST_BY_LOCALE[locale];
  const other = LIST_BY_LOCALE[locale === "id" ? "en" : "id"];
  const seen = new Set<string>();
  for (const word of text.toLowerCase().split(/[^\p{L}\p{N}']+/u)) {
    if (other.has(word) && !own.has(word)) seen.add(word);
    if (seen.size >= MIXED_TEXT_MIN_WORDS) return [own, other];
  }
  return [own];
}

export const isStopWord = (word: string, locale?: StopWordLocale) => {
  const w = word.toLowerCase();
  return stopWordLists(w, locale).some((list) => list.has(w));
};

/** Drops stop words from both ends of a phrase ("yang bermanfaat" -> "bermanfaat"); empty when nothing is left. */
export function trimStopWords(phrase: string, locale?: StopWordLocale): string {
  const lists = stopWordLists(phrase, locale);
  const isStop = (word: string) => lists.some((list) => list.has(word.toLowerCase()));
  const words = phrase.split(/\s+/).filter(Boolean);
  let start = 0;
  let end = words.length;
  while (start < end && isStop(words[start])) start++;
  while (end > start && isStop(words[end - 1])) end--;
  return words.slice(start, end).join(" ");
}
