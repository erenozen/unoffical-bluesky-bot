import fs from "fs";
import Parser from "rss-parser";
import pkg from "@atproto/api";
const { BskyAgent, RichText } = pkg;
import * as cheerio from "cheerio";
import fetch from "node-fetch";

// Configuration
const RSS_URL = "http://feeds.bbci.co.uk/turkce/rss.xml";
const STATE_FILE = "state.json";

// Helper: Fetch with 20-second timeout
const fetchWithTimeout = async (url, options = {}) => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20000);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    return response;
  } finally {
    clearTimeout(timeout);
  }
};

async function main() {
  const parser = new Parser();
  const agent = new BskyAgent({ service: "https://bsky.social" });

  console.log("Bot started...");

  // 1. Login
  try {
    await agent.login({
      identifier: process.env.BLUESKY_HANDLE,
      password: process.env.BLUESKY_PASSWORD,
    });
  } catch (err) {
    console.error("Login failed:", err);
    process.exit(1);
  }

  // 2. Fetch RSS
  let feed;
  try {
    feed = await parser.parseURL(RSS_URL);
  } catch (e) {
    console.error("RSS fetch failed:", e);
    process.exit(0);
  }

  // 3. Load History (The list of links we have already posted)
  let postedHistory = [];
  if (fs.existsSync(STATE_FILE)) {
    try {
      const state = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
      
      if (Array.isArray(state.history)) {
        // New format: Array of links
        postedHistory = state.history;
      } else if (state.last_link) {
        // Migration: Old format (single link) -> convert to list
        console.log("Migrating state file to new History format...");
        postedHistory = [state.last_link];
      }
    } catch (e) {
      console.log("State file corrupt/empty. Starting fresh.");
    }
  }

  // 4. Filter: Find items that are NOT in our history
  // We check every single item in the feed.
  const allValidItems = feed.items.filter(item => 
    item.link && 
    item.title && 
    !item.title.includes("Abone olmak için") // Remove Whatsapp link
  );

  // "If link is NOT in history, it is new."
  let newItems = allValidItems.filter(item => !postedHistory.includes(item.link));

  // Safety: If this is the very first run (history is empty), 
  // we don't want to spam 20 posts. Just mark them all as "seen" except the newest one.
  if (postedHistory.length === 0 && newItems.length > 5) {
    console.log("First run detected. Skipping old backlog, posting only the newest story.");
    // Add everything to history so we don't post them later
    postedHistory = newItems.map(i => i.link);
    // Only keep the newest one to post now
    newItems = [newItems[0]];
  }

  if (newItems.length === 0) {
    console.log("No new items found.");
    process.exit(0);
  }

  // 5. Sort by Date (Oldest -> Newest) so they appear in order on timeline
  newItems.sort((a, b) => new Date(a.isoDate) - new Date(b.isoDate));

  console.log(`Found ${newItems.length} new stories.`);

  // 6. Post Loop
  for (const item of newItems) {
    try {
      await postToBluesky(agent, item);

      // Add to history immediately
      postedHistory.push(item.link);
      
      // Keep history size manageable (remember last 100 links)
      // This prevents the file from getting too big over years
      if (postedHistory.length > 100) {
        postedHistory = postedHistory.slice(-100);
      }

      // Save State
      fs.writeFileSync(STATE_FILE, JSON.stringify({ history: postedHistory }));
      console.log(`Saved to history: ${item.title.substring(0, 20)}...`);

      // Pause
      await new Promise(resolve => setTimeout(resolve, 2000));

    } catch (e) {
      console.error(`Failed to post: ${item.title}`, e);
    }
  }
}

async function postToBluesky(agent, item) {
  const title = item.title.trim();
  const link = item.link;
  const desc = item.contentSnippet ? item.contentSnippet.substring(0, 250) + "..." : "";

  console.log(`Posting: "${title}"`);

  let imageBlob = null;
  try {
    const pageResponse = await fetchWithTimeout(link);
    const html = await pageResponse.text();
    const $ = cheerio.load(html);
    const imageUrl = $('meta[property="og:image"]').attr("content");

    if (imageUrl) {
      const imageResponse = await fetchWithTimeout(imageUrl);
      const buffer = await imageResponse.arrayBuffer();
      if (buffer.byteLength < 950000) {
        const { data } = await agent.uploadBlob(new Uint8Array(buffer), {
          encoding: imageResponse.headers.get("content-type") || "image/jpeg",
        });
        imageBlob = data.blob;
      }
    }
  } catch (e) {
    console.log(`Image skipped: ${e.message}`);
  }

  const rt = new RichText({ text: title });
  await rt.detectFacets(agent);

  const embed = {
    $type: "app.bsky.embed.external",
    external: { uri: link, title: title, description: desc },
  };

  if (imageBlob) embed.external.thumb = imageBlob;

  await agent.post({
    text: rt.text,
    facets: rt.facets,
    langs: ["tr"],
    embed: embed,
    createdAt: new Date().toISOString(),
  });
}

main().then(() => {
  process.exit(0);
}).catch((error) => {
  console.error("Fatal Error:", error);
  process.exit(1);
});
