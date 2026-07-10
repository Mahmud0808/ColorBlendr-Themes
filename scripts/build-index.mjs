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
writeFileSync("index.json", JSON.stringify(index));
console.log(`index.json built with ${index.length} theme(s)`);
