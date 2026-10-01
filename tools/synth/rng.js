'use strict';

// Deterministic pseudo-random source for the alert generator.
//
// The generator's contract is "same seed, same dataset", so this is a pinned
// algorithm rather than a wrapper over Math.random: mulberry32, seeded from a
// 32-bit FNV-1a hash of the seed string. Both are small enough to read, which
// matters more here than statistical quality — the output is alert fixtures,
// not a simulation anyone draws conclusions from.
//
// Changing either function changes every dataset ever generated from a given
// seed. test/generate.test.js pins a known seed to a known first record so
// that change cannot happen silently.

/** Fold a string or number seed into a uint32. */
function hashSeed(seed) {
  if (typeof seed === 'number' && Number.isFinite(seed)) return seed >>> 0;
  const s = String(seed);
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function makeRng(seed) {
  let a = hashSeed(seed);

  function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  return {
    next,
    /** Integer in [min, max], both inclusive. */
    int(min, max) {
      return min + Math.floor(next() * (max - min + 1));
    },
    /** Float in [min, max), rounded to `decimals` places. */
    float(min, max, decimals) {
      const v = min + next() * (max - min);
      return parseFloat(v.toFixed(decimals === undefined ? 2 : decimals));
    },
    pick(arr) {
      return arr[Math.floor(next() * arr.length)];
    },
    chance(p) {
      return next() < p;
    },
  };
}

module.exports = { makeRng, hashSeed };
