/**
 * Scans all posts for author arrays, fetches GitHub profile data for each
 * unique username, and writes public/authors.json as a cache.
 *
 * Called as part of the build pipeline. The cache file is committed so
 * runtime doesn't depend on GitHub API availability.
 */

const fs = require('fs');
const path = require('path');
const https = require('https');

const postsDir = path.join(process.cwd(), 'public/posts');
const authorsFile = path.join(process.cwd(), 'public/authors.json');

function parseFrontmatter(raw) {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) return { data: {} };
  const data = {};
  for (const line of match[1].split('\n')) {
    const colon = line.indexOf(':');
    if (colon === -1) continue;
    const key = line.slice(0, colon).trim();
    let val = line.slice(colon + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (val.startsWith('[') && val.endsWith(']')) {
      data[key] = val.slice(1, -1).split(',').map(s => s.trim().replace(/^["']|["']$/g, ''));
    } else {
      data[key] = val;
    }
  }
  return { data };
}

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'pulsar-blog' } }, (res) => {
      let body = '';
      res.on('data', (chunk) => body += chunk);
      res.on('end', () => {
        if (res.statusCode === 403 && res.headers['x-ratelimit-remaining'] === '0') {
          console.warn('  GitHub API rate limit hit. Using cached data if available.');
          resolve(null);
          return;
        }
        if (res.statusCode !== 200) {
          reject(new Error(`HTTP ${res.statusCode}: ${body.slice(0, 200)}`));
          return;
        }
        resolve(JSON.parse(body));
      });
    }).on('error', reject);
  });
}

async function main() {
  // Collect unique authors
  const allAuthors = new Set();
  if (fs.existsSync(postsDir)) {
    const files = fs.readdirSync(postsDir).filter(f => f.endsWith('.md'));
    for (const file of files) {
      const raw = fs.readFileSync(path.join(postsDir, file), 'utf-8');
      const { data } = parseFrontmatter(raw);
      const authors = data.author;
      if (Array.isArray(authors)) {
        for (const a of authors) allAuthors.add(a);
      } else if (typeof authors === 'string' && authors) {
        allAuthors.add(authors);
      }
    }
  }

  if (allAuthors.size === 0) {
    console.log('No authors found. Writing empty authors.json.');
    fs.writeFileSync(authorsFile, JSON.stringify({}, null, 2));
    return;
  }

  // Load existing cache
  let cache = {};
  if (fs.existsSync(authorsFile)) {
    try { cache = JSON.parse(fs.readFileSync(authorsFile, 'utf-8')); } catch {}
  }

  const usernames = [...allAuthors].filter(u => u && u !== 'Pulsar Team');
  console.log(`Fetching ${usernames.length} author(s): ${usernames.join(', ')}`);

  for (const username of usernames) {
    // Skip if cache is fresh (we keep it indefinitely; re-fetch by deleting the file)
    if (cache[username] && cache[username].name) {
      console.log(`  ${username} — cached`);
      continue;
    }
    try {
      console.log(`  Fetching ${username}...`);
      const profile = await fetchJson(`https://api.github.com/users/${username}`);
      if (!profile) {
        console.warn(`  ${username} — no data returned, keeping cache if any`);
        continue;
      }
      cache[username] = {
        login: profile.login,
        name: profile.name || profile.login,
        avatar_url: profile.avatar_url,
        html_url: profile.html_url,
        bio: profile.bio || '',
      };
      console.log(`  ${username} — ${profile.name || profile.login}`);
    } catch (err) {
      console.warn(`  ${username} — failed: ${err.message}`);
    }
    // Respect GitHub API rate limiting
    await new Promise(r => setTimeout(r, 200));
  }

  fs.writeFileSync(authorsFile, JSON.stringify(cache, null, 2));
  console.log(`Wrote authors.json (${Object.keys(cache).length} entries)`);
}

main().catch(err => { console.error(err); process.exit(1); });
