import fs from "node:fs";
import path from "node:path";

/**
 * Per-site overrides for the browser layer, keyed by hostname (no "www.").
 * Put them in recipes.json at the project root — see recipes.example.json.
 * Any field you leave out falls back to BUILT_IN below, then to the built-in guesses.
 */
export interface Recipe {
  /** Links to individual videos on a gallery/thumbnails page. */
  thumbnail?: string;
  /** Server / mirror / source buttons on a video page, tried in order. */
  server?: string;
  /** Play button, in the page or inside the player iframe. */
  play?: string;
  /** How long to wait for a stream after each server click (ms). Default 10000. */
  waitMs?: number;
  /** Gallery: how long to wait for the first thumbnail to render (ms). Default 15000, only used with `thumbnail`. */
  renderMs?: number;
  /** Gallery: how many screens to scroll so more thumbnails load. Default 4. */
  scrolls?: number;
  /** Gallery: pause after each scroll for the next batch to load (ms). Default 400. */
  scrollPauseMs?: number;
  /** Gallery: when looking for videos not downloaded yet, give up after this many extra rounds of 3 scrolls. Default 40. */
  maxScrolls?: number;
  /** Gallery: category or tab buttons to step through when the first list runs out of new videos. */
  sections?: string;
  /** Close buttons on pop-ups (like a sign-in prompt) that cover the page. Not for CAPTCHAs — those stop the scan. */
  dismiss?: string;
}

/** Sites that need a recipe to work at all. An entry in recipes.json for the same site overrides these field by field. */
const BUILT_IN: Record<string, Recipe> = {
  // Explore, profile, tag and search pages: the grid renders late and keeps loading as you scroll.
  // Signed out, explore stops after about 50 videos, so new ones come from its category chips.
  "tiktok.com": {
    thumbnail: "a[href*='/video/']",
    renderMs: 30_000,
    scrolls: 10,
    scrollPauseMs: 1_500,
    maxScrolls: 25,
    sections: "[data-e2e='explore-category-chip']",
    dismiss: "[data-e2e='modal-close-inner-button']",
  },
};

const FILE = path.resolve("recipes.json");

export function getRecipe(url: string): Recipe {
  let host: string;
  try { host = new URL(url).hostname.replace(/^www\./, ""); } catch { return {}; }
  let user: Record<string, Recipe> = {};
  try { user = JSON.parse(fs.readFileSync(FILE, "utf8")); } catch { /* no recipes.json, or invalid JSON */ }
  // Exact host, then parent domains (video.example.com → example.com).
  const parts = host.split(".");
  for (let i = 0; i < parts.length - 1; i++) {
    const key = parts.slice(i).join(".");
    if (user[key] || BUILT_IN[key]) return { ...BUILT_IN[key], ...user[key] };
  }
  return {};
}
