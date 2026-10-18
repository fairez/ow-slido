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
export const isStopWord = (word: string) => {
  const w = word.toLowerCase();
  return INDONESIAN_STOP_WORDS.has(w) || ENGLISH_STOP_WORDS.has(w);
};

/** Drops stop words from both ends of a phrase ("yang bermanfaat" -> "bermanfaat"); empty when nothing is left. */
export function trimStopWords(phrase: string): string {
  const words = phrase.split(/\s+/).filter(Boolean);
  let start = 0;
  let end = words.length;
  while (start < end && isStopWord(words[start])) start++;
  while (end > start && isStopWord(words[end - 1])) end--;
  return words.slice(start, end).join(" ");
}
