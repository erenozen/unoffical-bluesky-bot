# Unofficial BBC Türkçe Bluesky Bot 🦋

A serverless bot that automatically fetches the latest news from the **BBC Türkçe RSS feed** and reposts it to [Bluesky](https://bsky.app/profile/resmiyetsizbot.bsky.social). 

Built with **Node.js** and **GitHub Actions**. It runs on a scheduled cron job.

## Features

- **Automated:** Runs every 30 minutes via GitHub Actions.
- **Smart Deduplication:** Uses a \`state.json\` file to track the last posted link and prevent duplicates.
- **Rich Media:** Scrapes the article page to find the best image (\`og:image\`) and attaches it to the Bluesky post.
- **Serverless:** No VPS or hosting costs required.

## Setup

### Prerequisites
1. A GitHub account.
2. A Bluesky account.

### Installation

1. **Clone or Fork** this repository.
2. Install dependencies (creates \`package-lock.json\`):
   \`\`\`bash
   npm install
   \`\`\`
3. **Configure Secrets**:
   Go to your repository **Settings** > **Secrets and variables** > **Actions** and add:
   - \`BLUESKY_HANDLE\`: Your full handle (e.g., \`username.bsky.social\`)
   - \`BLUESKY_PASSWORD\`: Your App Password (create one in Bluesky Settings > App Passwords).

### How it Works

The logic is contained in \`index.js\`:
1. **Fetch:** Parses the RSS feed \`http://feeds.bbci.co.uk/turkce/rss.xml\`.
2. **Check:** Compares the latest link against \`state.json\`.
3. **Scrape:** If new, fetches the article HTML to extract the metadata image.
4. **Post:** Uploads the image and creates a post on Bluesky using the \`@atproto/api\`.
5. **Save:** Updates \`state.json\` and commits it back to the repo.

## Disclaimer

This is an **unofficial** project and is not affiliated with, associated with, or endorsed by the BBC.

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.
