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
  const timeout = setTimeout(() => controller.abort(), 20000); // 20 seconds max
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
    console.log("Logged in to Bluesky.");
  } catch (err) {
    console.error("Login failed:", err);
    process.exit(1);
  }

  // 2. Fetch and Clean RSS Feed
  let feed;
  try {
    feed = await parser.parseURL(RSS_URL);
  } catch (e) {
    console.error("RSS fetch failed:", e);
    process.exit(0);
  }

  // Filter out empty items and ads
  // We strictly require a Title, Link, and Date.
  const allItems = feed.items.filter(item => 
    item.title && 
    item.link && 
    item.isoDate &&
    !item.title.includes("Abone olmak için") // Filter out the WhatsApp Ad
  );

  // 3. CRITICAL FIX: Sort items by Date (Newest first) manually
  // This fixes the issue where BBC puts older stories at the top
  allItems.sort((a, b) => new Date(b.isoDate) - new Date(a.isoDate));

  // 4. Load State
  let lastPostedTime = 0;
  let lastPostedLink = "";
  
  if (fs.existsSync(STATE_FILE)) {
    try {
      const state = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
      // We prioritize 'last_time' if it exists, otherwise fall back to 'last_link'
      if (state.last_time) {
        lastPostedTime = new Date(state.last_time).getTime();
      } else if (state.last_link) {
        // Legacy migration: If we only have a link, find its date in the current feed
        const foundItem = allItems.find(i => i.link === state.last_link);
        if (foundItem) {
          lastPostedTime = new Date(foundItem.isoDate).getTime();
          console.log(`Migrating legacy state. Last post date: ${foundItem.isoDate}`);
        }
      }
    } catch (e) {
      console.log("State file empty or corrupt. Resetting.");
    }
  }

  // 5. Select items to post
  // We want everything NEWER than our last posted time
  let newItems = [];

  if (lastPostedTime === 0) {
    console.log("First run (or state reset). Catching up with latest 1 story.");
    newItems = [allItems[0]]; // Safety: Just post the absolute newest one
  } else {
    // Filter: Item date > Last posted date
    newItems = allItems.filter(item => {
      const itemTime = new Date(item.isoDate).getTime();
      return itemTime > lastPostedTime;
    });
  }

  if (newItems.length === 0) {
    console.log("No new items found.");
    process.exit(0);
  }

  // 6. Sort Oldest -> Newest for posting timeline
  newItems.sort((a, b) => new Date(a.isoDate) - new Date(b.isoDate));

  console.log(`Found ${newItems.length} new stories to post.`);

  // 7. Post Loop
  for (const item of newItems) {
    try {
      await postToBluesky(agent, item);
      
      // Update state IMMEDIATELY after success
      const newState = {
        last_link: item.link,
        last_time: item.isoDate
      };
      fs.writeFileSync(STATE_FILE, JSON.stringify(newState));
      console.log(`State saved: ${item.isoDate}`);
      
      // Pause to be nice to API
      await new Promise(resolve => setTimeout(resolve, 2000));

    } catch (e) {
      console.error(`FAILED to post story: "${item.title}"`, e);
      // We continue to the next item so one error doesn't block the queue
    }
  }
}

async function postToBluesky(agent, item) {
  const title = item.title.trim();
  const link = item.link;
  // Truncate description to prevent "Text too long" errors
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
      
      // Skip if image is gigantic (>900KB) to prevent API errors
      if (buffer.byteLength < 950000) {
        const { data } = await agent.uploadBlob(new Uint8Array(buffer), {
          encoding: imageResponse.headers.get("content-type") || "image/jpeg",
        });
        imageBlob = data.blob;
      } else {
        console.log("Image too large, posting text only.");
      }
    }
  } catch (e) {
    console.log(`Image fetch skipped: ${e.message}`);
  }

  const rt = new RichText({ text: title });
  await rt.detectFacets(agent);

  const embed = {
    $type: "app.bsky.embed.external",
    external: {
      uri: link,
      title: title,
      description: desc,
    },
  };

  if (imageBlob) embed.external.thumb = imageBlob;

  await agent.post({
    text: rt.text,
    facets: rt.facets,
    langs: ["tr"],
    embed: embed,
    createdAt: new Date().toISOString(),
  });
  console.log("Posted successfully!");
}

// Force quit to prevent hanging
main().then(() => {
  process.exit(0);
}).catch((error) => {
  console.error("Fatal Error:", error);
  process.exit(1);
});
