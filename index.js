import fs from "fs";
import Parser from "rss-parser";
import pkg from "@atproto/api";
const { BskyAgent, RichText } = pkg;
import * as cheerio from "cheerio";
import fetch from "node-fetch";

// Configuration
const RSS_URL = "http://feeds.bbci.co.uk/turkce/rss.xml";
const STATE_FILE = "state.json";

// Helper: Fetch with 5-second timeout
const fetchWithTimeout = async (url, options = {}) => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 42000); // 42 seconds max
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

  try {
    await agent.login({
      identifier: process.env.BLUESKY_HANDLE,
      password: process.env.BLUESKY_PASSWORD,
    });
  } catch (err) {
    console.error("Login failed:", err);
    process.exit(1);
  }

  // Fetch RSS
  const feed = await parser.parseURL(RSS_URL);
  
  // Read State
  let lastPostedLink = "";
  if (fs.existsSync(STATE_FILE)) {
    try {
      const state = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
      lastPostedLink = state.last_link;
    } catch (e) {
      console.log("State file empty/corrupt.");
    }
  }

  // --- CATCH-UP LOGIC ---
  const lastIndex = feed.items.findIndex((item) => item.link === lastPostedLink);
  let newItems = [];

  if (lastIndex === -1) {
    if (lastPostedLink === "") {
        console.log("First run. Posting latest story.");
        newItems = [feed.items[0]];
    } else {
        console.log("Last link not found (too old). Catching up with latest 3.");
        newItems = feed.items.slice(0, 3); 
    }
  } else if (lastIndex === 0) {
    console.log("No new items.");
    return;
  } else {
    newItems = feed.items.slice(0, lastIndex);
  }

  newItems.reverse(); // Oldest first
  console.log(`Found ${newItems.length} new stories.`);

  for (const item of newItems) {
    await postToBluesky(agent, item);
    // Tiny pause between posts
    await new Promise(resolve => setTimeout(resolve, 1000));
  }

  // Save new state
  fs.writeFileSync(STATE_FILE, JSON.stringify({ last_link: feed.items[0].link }));
  console.log("State updated.");
}

async function postToBluesky(agent, item) {
    const title = item.title;
    const link = item.link;
    const desc = item.contentSnippet || "";

    console.log(`Posting: ${title}`);

    let imageBlob = null;
    try {
        // Scrape with timeout
        const pageResponse = await fetchWithTimeout(link);
        const html = await pageResponse.text();
        const $ = cheerio.load(html);
        const imageUrl = $('meta[property="og:image"]').attr("content");

        if (imageUrl) {
            const imageResponse = await fetchWithTimeout(imageUrl);
            const buffer = await imageResponse.arrayBuffer();
            const { data } = await agent.uploadBlob(new Uint8Array(buffer), {
                encoding: imageResponse.headers.get("content-type") || "image/jpeg",
            });
            imageBlob = data.blob;
        }
    } catch (e) {
        console.log("Image skip (timeout or error):", e.message);
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
}

main().then(() => {
  process.exit(0); // Force quit successfully
}).catch((error) => {
  console.error(error);
  process.exit(1); // Force quit with error
});
