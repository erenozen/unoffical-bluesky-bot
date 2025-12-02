import fs from "fs";
import Parser from "rss-parser"; // To read the RSS feed
import pkg from "@atproto/api";
const { BskyAgent, RichText } = pkg;
import * as cheerio from "cheerio"; // For scraping the image
import fetch from "node-fetch"; // For fetching HTML and Images

// Configuration
const RSS_URL = "http://feeds.bbci.co.uk/turkce/rss.xml";
const STATE_FILE = "state.json";

async function main() {
  // 1. Initialize RSS Parser and Bluesky Agent
  const parser = new Parser();
  const agent = new BskyAgent({ service: "https://bsky.social" });

  // 2. Login
  try {
    await agent.login({
      identifier: process.env.BLUESKY_HANDLE,
      password: process.env.BLUESKY_PASSWORD,
    });
  } catch (err) {
    console.error("Login failed:", err);
    process.exit(1);
  }

  // 3. Fetch RSS Feed
  const feed = await parser.parseURL(RSS_URL);
  if (!feed.items || feed.items.length === 0) {
    console.log("No items found in RSS feed.");
    return;
  }

  // We only care about the very newest item for this bot
  const latestItem = feed.items[0];
  const latestLink = latestItem.link;
  const latestTitle = latestItem.title;
  const latestDesc = latestItem.contentSnippet || "";

  // 4. Check State (Prevent Duplicates)
  let lastPostedLink = "";
  if (fs.existsSync(STATE_FILE)) {
    const stateData = fs.readFileSync(STATE_FILE, "utf8");
    try {
      const state = JSON.parse(stateData);
      lastPostedLink = state.last_link;
    } catch (e) {
      console.log("State file corrupted or empty, resetting.");
    }
  }

  if (latestLink === lastPostedLink) {
    console.log("Already posted this story. Skipping.");
    return;
  }

  console.log(`New story found: ${latestTitle}`);

  // 5. Scrape Image (Your original Pipedream logic adapted)
  let imageBlob = null;
  try {
    const pageResponse = await fetch(latestLink);
    const html = await pageResponse.text();
    const $ = cheerio.load(html);
    const imageUrl = $('meta[property="og:image"]').attr("content");

    if (imageUrl) {
      const imageResponse = await fetch(imageUrl);
      const imageBuffer = await imageResponse.arrayBuffer();

      // Convert ArrayBuffer to Uint8Array for Bluesky
      const { data: uploadedImage } = await agent.uploadBlob(
        new Uint8Array(imageBuffer),
        { encoding: imageResponse.headers.get("content-type") || "image/jpeg" },
      );
      imageBlob = uploadedImage.blob;
    }
  } catch (error) {
    console.error(
      "Could not scrape or upload image (continuing without it):",
      error,
    );
  }

  // 6. Prepare the Post
  const rt = new RichText({ text: latestTitle });
  await rt.detectFacets(agent);

  const embed = {
    $type: "app.bsky.embed.external",
    external: {
      uri: latestLink,
      title: latestTitle,
      description: latestDesc,
    },
  };

  if (imageBlob) {
    embed.external.thumb = imageBlob;
  }

  // 7. Post to Bluesky
  await agent.post({
    text: rt.text,
    facets: rt.facets,
    langs: ["tr"],
    embed: embed,
    createdAt: new Date().toISOString(),
  });

  console.log("Posted successfully!");

  // 8. Update State File
  fs.writeFileSync(STATE_FILE, JSON.stringify({ last_link: latestLink }));
}

main();
