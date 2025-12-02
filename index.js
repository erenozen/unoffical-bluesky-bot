import fs from "fs";
import Parser from "rss-parser";
import pkg from "@atproto/api";
const { BskyAgent, RichText } = pkg;
import * as cheerio from "cheerio";
import fetch from "node-fetch";

// Configuration
const RSS_URL = "http://feeds.bbci.co.uk/turkce/rss.xml";
const STATE_FILE = "state.json";

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

  // Fetch the RSS feed
  const feed = await parser.parseURL(RSS_URL);
  
  // Read the last posted link from state
  let lastPostedLink = "";
  if (fs.existsSync(STATE_FILE)) {
    try {
      const state = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
      lastPostedLink = state.last_link;
    } catch (e) {
      console.log("State file empty/corrupt.");
    }
  }

  // --- NEW LOGIC: FIND ALL NEW ITEMS ---
  
  // 1. Find the index of the last posted link in the new feed
  // feed.items is usually sorted [Newest, ..., Oldest]
  const lastIndex = feed.items.findIndex((item) => item.link === lastPostedLink);

  let newItems = [];

  if (lastIndex === -1) {
    // SCENARIO A: We didn't find the last link. 
    // This happens if:
    // 1. It's the very first run (lastPostedLink is empty).
    // 2. The bot was off for a long time and the last link is too old (gone from RSS).
    
    if (lastPostedLink === "") {
        console.log("First run. Posting only the single latest story.");
        newItems = [feed.items[0]];
    } else {
        console.log("Last link not found in feed (too old?). Posting latest 3 to catch up.");
        // Safety cap: don't spam 50 posts if the bot was off for a week.
        newItems = feed.items.slice(0, 3); 
    }
  } else if (lastIndex === 0) {
    // SCENARIO B: The top item is the same as our last saved link.
    console.log("No new items.");
    return;
  } else {
    // SCENARIO C: We found the last link. 
    // Example: last link is at index 3. That means indices 0, 1, and 2 are new.
    newItems = feed.items.slice(0, lastIndex);
  }

  // 2. Reverse the array so we post OLDEST first (Timeline order)
  newItems.reverse();

  console.log(`Found ${newItems.length} new stories.`);

  // 3. Loop through and post each one
  for (const item of newItems) {
    await postToBluesky(agent, item);
    
    // Wait 2 seconds between posts to be nice to the API
    await new Promise(resolve => setTimeout(resolve, 2000));
  }

  // 4. Update state with the very newest link (which is now the last one we posted)
  // Note: Because we reversed newItems, the "newest" story is actually the LAST item in our processed list.
  // But strictly speaking, the newest item in the RSS feed is feed.items[0].
  fs.writeFileSync(STATE_FILE, JSON.stringify({ last_link: feed.items[0].link }));
  console.log("State updated.");
}

async function postToBluesky(agent, item) {
    const title = item.title;
    const link = item.link;
    const desc = item.contentSnippet || "";

    console.log(`Posting: ${title}`);

    // Scrape Image
    let imageBlob = null;
    try {
        const pageResponse = await fetch(link);
        const html = await pageResponse.text();
        const $ = cheerio.load(html);
        const imageUrl = $('meta[property="og:image"]').attr("content");

        if (imageUrl) {
            const imageResponse = await fetch(imageUrl);
            const buffer = await imageResponse.arrayBuffer();
            const { data } = await agent.uploadBlob(new Uint8Array(buffer), {
                encoding: imageResponse.headers.get("content-type") || "image/jpeg",
            });
            imageBlob = data.blob;
        }
    } catch (e) {
        console.error("Image fetch failed, posting text only.");
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

main();
