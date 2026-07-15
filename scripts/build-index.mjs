// Builds index.json from themes/*.json, baking in vote counts from the
// worker and download counts from jsDelivr stats.
//   WORKER_URL env var: https://colorblendr-themes.<subdomain>.workers.dev
import { readdirSync, readFileSync, writeFileSync } from "node:fs";

const GITHUB_REPO = "Mahmud0808/ColorBlendr-Themes";
const workerUrl = process.env.WORKER_URL ?? "";

async function fetchJson(url) {
    try {
        const response = await fetch(url);
        if (!response.ok) return null;
        return await response.json();
    } catch {
        return null;
    }
}

const counts = workerUrl ? (await fetchJson(`${workerUrl}/counts`)) ?? {} : {};
const votes = counts.upvotes ?? {};
const downloads = counts.downloads ?? {};

const index = [];
for (const file of readdirSync("themes").filter((f) => f.endsWith(".json"))) {
    const theme = JSON.parse(readFileSync(`themes/${file}`, "utf8"));
    index.push({
        ...theme,
        upvotes: votes[theme.id] ?? 0,
        downloads: downloads[theme.id] ?? 0
    });
}

index.sort((a, b) => (b.upvotes - a.upvotes) || (b.createdAt - a.createdAt));

// App reads first MAX_THEMES entries. Top slots by votes + reserved newest
// slots so unvoted newcomers always surface.
const MAX_THEMES = 2000;
const NEWEST_SLOTS = 150;
let final = index;
if (index.length > MAX_THEMES) {
    const newest = [...index]
        .sort((a, b) => b.createdAt - a.createdAt)
        .slice(0, NEWEST_SLOTS);
    const newestIds = new Set(newest.map((t) => t.id));
    const topVoted = index
        .filter((t) => !newestIds.has(t.id))
        .slice(0, MAX_THEMES - NEWEST_SLOTS);
    final = [...topVoted, ...newest]
        .sort((a, b) => (b.upvotes - a.upvotes) || (b.createdAt - a.createdAt));
    console.log(`capped: ${index.length} -> ${final.length} (${NEWEST_SLOTS} newest reserved)`);
}

writeFileSync("index.json", JSON.stringify(final));
console.log(`index.json built with ${final.length} theme(s)`);
