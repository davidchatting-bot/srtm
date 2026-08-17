// Pre-warms the contour-tiles disk cache for an area, so sharing the demo
// doesn't trigger a slow first render for whoever opens it next. Requires the
// server to already be running (this just makes the same requests a browser
// panning the slippy map would, so they land in cache/ ahead of time).
//
// Usage:
//   node warm-cache.js
//   node warm-cache.js --lat 56.2208 --lon -2.7036 --zooms 12-17 --radius 2
//   node warm-cache.js --base-url http://localhost:3000

function parseArgs(argv) {
  const args = { lat: 56.2208, lon: -2.7036, zooms: "12-17", radius: 2, baseUrl: "http://localhost:3000", concurrency: 6 };
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith("--")) continue;
    const key = argv[i].slice(2);
    const value = argv[++i];
    if (key === "base-url") args.baseUrl = value;
    else if (key === "lat" || key === "lon" || key === "radius" || key === "concurrency") args[key] = parseFloat(value);
    else if (key === "zooms") args.zooms = value;
  }
  return args;
}

function lonLatToTile(lon, lat, z) {
  const n = 2 ** z;
  const x = Math.floor(((lon + 180) / 360) * n);
  const latRad = (lat * Math.PI) / 180;
  const y = Math.floor(((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n);
  return { x, y };
}

async function warmTile(baseUrl, z, x, y) {
  // Matches the URL contours.html's tile layer actually requests by default
  // (see buildTileUrl() in p5js/contours.html) — same params, same cache key.
  const url = `${baseUrl}/contour-tiles/${z}/${x}/${y}.svg?resolution=128`;
  const res = await fetch(url);
  return { z, x, y, status: res.status, ok: res.ok };
}

async function runPool(tasks, concurrency) {
  const results = new Array(tasks.length);
  let next = 0;
  async function worker() {
    while (next < tasks.length) {
      const i = next++;
      results[i] = await tasks[i]();
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));
  return results;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const [zMin, zMax] = String(args.zooms).split("-").map(Number);
  const radius = Math.round(args.radius);

  const tasks = [];
  for (let z = zMin; z <= zMax; z++) {
    const { x: cx, y: cy } = lonLatToTile(args.lon, args.lat, z);
    for (let dx = -radius; dx <= radius; dx++) {
      for (let dy = -radius; dy <= radius; dy++) {
        const x = cx + dx, y = cy + dy;
        tasks.push(() => warmTile(args.baseUrl, z, x, y));
      }
    }
  }

  console.log(`Warming ${tasks.length} tiles for (${args.lat}, ${args.lon}) across zooms ${zMin}-${zMax}, radius ${radius} tiles...`);
  const start = Date.now();
  const results = await runPool(tasks, args.concurrency);
  const failed = results.filter(r => !r.ok);
  const elapsed = ((Date.now() - start) / 1000).toFixed(1);

  console.log(`Done in ${elapsed}s: ${results.length - failed.length} ok, ${failed.length} failed`);
  if (failed.length) {
    console.log("Failed tiles:");
    for (const f of failed) console.log(`  z=${f.z} x=${f.x} y=${f.y} -> HTTP ${f.status || "error"}`);
    process.exitCode = 1;
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
