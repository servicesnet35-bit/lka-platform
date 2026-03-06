const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

// Client configurations
const CLIENTS = [
    {
        name: 'ZK',
        dataFile: 'clients/zk/data.json',
        hashtags: ['zkstory'],
        format: 'simple' // { timestamp, views, videos }
    },
    {
        name: 'Franglish',
        dataFile: 'clients/franglish/data.json',
        hashtags: ['franglish', 'franglishstory'],
        format: 'multi' // { timestamp, franglish: {views, videos}, franglishstory: {views, videos} }
    },
    {
        name: 'You',
        dataFile: 'clients/you/data.json',
        hashtags: ['clip2you'],
        format: 'simple' // { timestamp, views, videos }
    }
];

const MAX_SNAPSHOTS = 240;

async function fetchHashtagStats(page, hashtag) {
    console.log(`  Fetching #${hashtag}...`);

    // Try browser fetch first (with cookies from TikTok homepage)
    const data = await page.evaluate(async (tag) => {
        try {
            const res = await fetch(`https://www.tiktok.com/api/challenge/detail/?challengeName=${tag}`);
            return res.json();
        } catch (e) {
            return null;
        }
    }, hashtag);

    if (data && data.statusCode === 0) {
        const views = parseInt(data.challengeInfo.statsV2.viewCount, 10);
        const videos = parseInt(data.challengeInfo.statsV2.videoCount, 10);
        console.log(`  #${hashtag}: ${views.toLocaleString()} views, ${videos.toLocaleString()} videos`);
        return { views, videos };
    }

    // Fallback: direct navigation
    console.log(`  Browser fetch failed for #${hashtag}, trying direct navigation...`);
    await page.goto(`https://www.tiktok.com/api/challenge/detail/?challengeName=${hashtag}`, {
        waitUntil: 'domcontentloaded',
        timeout: 30000
    });

    const bodyText = await page.textContent('body');
    if (!bodyText || bodyText.length < 10) {
        throw new Error(`Empty response from TikTok for #${hashtag}`);
    }

    const response = JSON.parse(bodyText);
    if (response.statusCode !== 0) {
        throw new Error(`TikTok API error for #${hashtag}: statusCode=${response.statusCode}`);
    }

    const views = parseInt(response.challengeInfo.statsV2.viewCount, 10);
    const videos = parseInt(response.challengeInfo.statsV2.videoCount, 10);
    console.log(`  #${hashtag}: ${views.toLocaleString()} views, ${videos.toLocaleString()} videos`);
    return { views, videos };
}

async function updateClient(page, client) {
    console.log(`\n--- ${client.name} ---`);

    const dataPath = path.resolve(__dirname, client.dataFile);
    const fileData = JSON.parse(fs.readFileSync(dataPath, 'utf8'));
    const timestamp = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');

    if (client.format === 'simple') {
        // Simple format: single hashtag -> { timestamp, views, videos }
        const stats = await fetchHashtagStats(page, client.hashtags[0]);

        if (!stats.views || stats.views === 0) {
            throw new Error(`Got 0 views for #${client.hashtags[0]}, skipping.`);
        }

        fileData.snapshots.push({
            timestamp,
            views: stats.views,
            videos: stats.videos
        });
    } else if (client.format === 'multi') {
        // Multi format: multiple hashtags -> { timestamp, hashtag1: {views, videos}, hashtag2: {views, videos} }
        const snapshot = { timestamp };
        let hasValidData = false;

        for (const hashtag of client.hashtags) {
            const stats = await fetchHashtagStats(page, hashtag);
            snapshot[hashtag] = {
                views: stats.views,
                videos: stats.videos
            };
            if (stats.views > 0) hasValidData = true;
        }

        if (!hasValidData) {
            throw new Error(`All hashtags returned 0 views for ${client.name}, skipping.`);
        }

        fileData.snapshots.push(snapshot);
    }

    // Trim to max snapshots
    if (fileData.snapshots.length > MAX_SNAPSHOTS) {
        fileData.snapshots = fileData.snapshots.slice(-MAX_SNAPSHOTS);
    }

    fs.writeFileSync(dataPath, JSON.stringify(fileData, null, 2) + '\n');
    console.log(`  Updated ${client.dataFile} (${fileData.snapshots.length} snapshots) at ${timestamp}`);
}

async function main() {
    const browser = await chromium.launch({
        headless: true,
        args: ['--no-sandbox', '--disable-blink-features=AutomationControlled']
    });

    const context = await browser.newContext({
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        locale: 'fr-FR'
    });

    const page = await context.newPage();

    try {
        // Visit TikTok homepage first to get cookies
        console.log('Loading TikTok homepage for cookies...');
        await page.goto('https://www.tiktok.com/', {
            waitUntil: 'domcontentloaded',
            timeout: 30000
        });
        await page.waitForTimeout(2000);

        // Update all clients
        let failures = 0;
        for (const client of CLIENTS) {
            try {
                await updateClient(page, client);
            } catch (err) {
                console.error(`ERROR updating ${client.name}: ${err.message}`);
                failures++;
            }
        }

        if (failures > 0) {
            console.error(`\n${failures}/${CLIENTS.length} client(s) failed.`);
            process.exit(1);
        }

        console.log(`\nAll ${CLIENTS.length} clients updated successfully.`);
    } catch (err) {
        console.error('Fatal error:', err.message);
        process.exit(1);
    } finally {
        await browser.close();
    }
}

main();
