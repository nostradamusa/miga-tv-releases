#!/usr/bin/env node
/**
 * MIGA TV Commercial Backend — Zero-Cost Trending, Box Office & Dual-Rating (IMDb + Rotten Tomatoes) Feed Generator
 *
 * Runs every 6 hours (via GitHub Actions Free Tier or local cron) and publishes `trending-feed.json`
 * to your release CDN (`nostradamusa/miga-tv-releases`).
 * Every MIGA TV client (Windows .exe, Android .apk, iOS .ipa) downloads `trending-feed.json` on startup
 * and cross-matches it against the user's local SQLite IPTV catalog in < 5ms.
 */

import fs from 'node:fs';
import path from 'node:path';

const RT_URLS = {
  inTheaters: 'https://www.rottentomatoes.com/browse/movies_in_theaters/sort:popular',
  trendingMovies: 'https://www.rottentomatoes.com/browse/movies_at_home/sort:popular',
  trendingSeries: 'https://www.rottentomatoes.com/browse/tv_series_browse/sort:popular',
};

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
};

function parseRtJsonLd(html) {
  const m = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/i);
  if (!m) return [];
  try {
    const j = JSON.parse(m[1].trim());
    const list = j?.itemListElement?.itemListElement ?? j?.itemListElement ?? [];
    if (!Array.isArray(list)) return [];
    return list
      .map((item) => ({
        title: String(item?.name ?? '').trim(),
        rtScore: Number.parseInt(String(item?.aggregateRating?.ratingValue ?? '0'), 10) || 0,
        imdbRating: 0.0,
        year: String(item?.dateCreated ?? '').trim(),
      }))
      .filter((x) => x.title.length > 0);
  } catch {
    return [];
  }
}

async function enrichWithOmdb(entry, type) {
  try {
    const url = `https://www.omdbapi.com/?t=${encodeURIComponent(entry.title)}&type=${type}&apikey=trilogy`;
    const res = await fetch(url, { headers: { 'User-Agent': 'MigaTV/1.0' } });
    if (!res.ok) return entry;
    const j = await res.json();
    if (j?.Response === 'True') {
      const imdb = Number.parseFloat(String(j.imdbRating ?? '0'));
      if (Number.isFinite(imdb) && imdb > 0) {
        entry.imdbRating = imdb;
      }
      if (!entry.year && j.Year) {
        entry.year = String(j.Year).slice(0, 4);
      }
      if (!entry.rtScore && Array.isArray(j.Ratings)) {
        const rtObj = j.Ratings.find((r) => String(r.Source).toLowerCase().includes('rotten tomatoes'));
        if (rtObj?.Value) {
          const parsedRt = Number.parseInt(String(rtObj.Value).replace('%', ''), 10);
          if (Number.isFinite(parsedRt) && parsedRt > 0) {
            entry.rtScore = parsedRt;
          }
        }
      }
    }
  } catch {
    // Keep existing RT chart entry
  }
  return entry;
}

async function fetchChart(url, type) {
  try {
    const res = await fetch(url, { headers: HEADERS });
    if (!res.ok) return [];
    const html = await res.text();
    const raw = parseRtJsonLd(html).slice(0, 24);
    const enriched = [];
    for (const item of raw) {
      enriched.push(await enrichWithOmdb(item, type));
    }
    return enriched;
  } catch {
    return [];
  }
}

async function main() {
  console.log('Fetching live Rotten Tomatoes & IMDb charts...');
  const [inTheaters, trendingMovies, trendingSeries] = await Promise.all([
    fetchChart(RT_URLS.inTheaters, 'movie'),
    fetchChart(RT_URLS.trendingMovies, 'movie'),
    fetchChart(RT_URLS.trendingSeries, 'series'),
  ]);

  const payload = {
    app: 'MIGA TV Commercial Feed',
    version: 1,
    updatedAtIso: new Date().toISOString(),
    inTheaters,
    trendingMovies,
    trendingSeries,
  };

  const outDir = path.resolve(process.cwd(), 'commercial_hub', 'releases', 'feed');
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, 'trending-feed.json');
  fs.writeFileSync(outPath, JSON.stringify(payload, null, 2), 'utf8');
  console.log(
    `Wrote ${outPath} (inTheaters=${inTheaters.length}, trendingMovies=${trendingMovies.length}, trendingSeries=${trendingSeries.length})`,
  );
}

main();
