import { readdir, mkdir, writeFile } from 'fs/promises';
import { createReadStream } from 'fs';
import readline from 'readline';
import zlib from 'zlib';
import path from 'path';

// Fetches your live channel list directly from your main data repository
const STATUS_URL = 'https://raw.githubusercontent.com/abhijeet620380/freetvgarden-data-v2/main/iptv/status.json';
const OUT_DIR = './epg';

function parseXmltvDate(str) {
  if (!str) return 0;
  const y = str.slice(0, 4), m = str.slice(4, 6), d = str.slice(6, 8);
  const h = str.slice(8, 10), min = str.slice(10, 12), sec = str.slice(12, 14);
  let tz = '+00:00';
  if (str.length > 15) tz = `${str.slice(15, 16)}${str.slice(16, 18)}:${str.slice(18, 20)}`;
  return new Date(`${y}-${m}-${d}T${h}:${min}:${sec}${tz}`).getTime();
}

function normalizeName(name) {
  return String(name).toLowerCase().replace(/\b(hd|fhd|uhd|4k|1080p|720p|sd|hq|tv|live)\b/g, '').replace(/[^a-z0-9]/g, '');
}

async function main() {
  console.log("Fetching channel list from main repository...");
  const res = await fetch(STATUS_URL);
  if (!res.ok) return console.log("Failed to fetch status.json. Ensure the main repository is public.");
  const statusData = await res.json();
  
  const validById = new Map(), validByName = new Map();
  statusData.forEach(c => {
    if (c.id && c.country && c.status === 'live') {
      const ourData = { originalId: c.id, country: c.country.toLowerCase() };
      validById.set(c.id.toLowerCase(), ourData);
      validByName.set(normalizeName(c.name), ourData);
    }
  });

  const files = await readdir('.');
  const guideFiles = files.filter(f => f.startsWith('guide-') && f.endsWith('.xml.gz'));
  if (guideFiles.length === 0) return console.log("No guide files found.");

  const now = Date.now(), next24h = now + (24 * 60 * 60 * 1000);
  const countryEpg = {};

  for (const file of guideFiles) {
    console.log(`Processing ${file}...`);
    const rl = readline.createInterface({ input: createReadStream(file).pipe(zlib.createGunzip()), crlfDelay: Infinity });
    const xmlIdToOurData = new Map();
    let currentXmlId = null, currentProg = null;

    for await (const line of rl) {
      if (line.includes('<channel id=')) {
        const match = line.match(/id="([^"]+)"/);
        if (match) currentXmlId = match[1];
        continue;
      }
      if (currentXmlId && line.includes('<display-name')) {
        const nameMatch = line.match(/>([^<]+)<\/display-name>/);
        if (nameMatch) {
          const normName = normalizeName(nameMatch[1]);
          if (validById.has(currentXmlId.toLowerCase())) xmlIdToOurData.set(currentXmlId, validById.get(currentXmlId.toLowerCase()));
          else if (validByName.has(normName)) xmlIdToOurData.set(currentXmlId, validByName.get(normName));
        }
        currentXmlId = null; continue;
      }
      if (line.includes('<programme ')) {
        const start = line.match(/start="([^"]+)"/), stop = line.match(/stop="([^"]+)"/), ch = line.match(/channel="([^"]+)"/);
        if (start && stop && ch && xmlIdToOurData.has(ch[1])) {
          const startTime = parseXmltvDate(start[1]), stopTime = parseXmltvDate(stop[1]);
          if (stopTime > now && startTime < next24h) {
            currentProg = { ourId: xmlIdToOurData.get(ch[1]).originalId, country: xmlIdToOurData.get(ch[1]).country, start: startTime, stop: stopTime, title: '' };
          }
        }
        continue;
      }
      if (currentProg && line.includes('<title')) {
        const titleMatch = line.match(/>([^<]+)<\/title>/);
        if (titleMatch) currentProg.title = titleMatch[1].replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
        continue;
      }
      if (currentProg && line.includes('</programme>')) {
        const cc = currentProg.country;
        if (!countryEpg[cc]) countryEpg[cc] = {};
        if (!countryEpg[cc][currentProg.ourId]) countryEpg[cc][currentProg.ourId] = [];
        countryEpg[cc][currentProg.ourId].push({ title: currentProg.title, start: currentProg.start, stop: currentProg.stop });
        currentProg = null;
      }
    }
  }

  await mkdir(OUT_DIR, { recursive: true });
  for (const [cc, channels] of Object.entries(countryEpg)) {
    for (const chId of Object.keys(channels)) channels[chId].sort((a, b) => a.start - b.start);
    await writeFile(path.join(OUT_DIR, `${cc}.json`), JSON.stringify(channels));
  }
  console.log("EPG build complete.");
}

main().catch(console.error);
