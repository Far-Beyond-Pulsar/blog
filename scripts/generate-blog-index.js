/**
 * Reads all markdown posts from public/posts/, extracts frontmatter,
 * computes reading time, writes blog-index.json, blog-preview.json, and blog-all.json.
 *
 * Post filenames become slugs: "2024-01-15-helio-renderer.md" → "2024-01-15-helio-renderer"
 */

const fs = require('fs');
const path = require('path');

const postsDir = path.join(process.cwd(), 'public/posts');
const indexFile = path.join(process.cwd(), 'public/blog-index.json');
const previewFile = path.join(process.cwd(), 'public/blog-preview.json');
const allFile = path.join(process.cwd(), 'public/blog-all.json');

// Minimal frontmatter parser (avoids requiring gray-matter at build-script level via CJS)
function parseFrontmatter(raw) {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) return { data: {}, content: raw };

  const data = {};
  for (const line of match[1].split('\n')) {
    const colon = line.indexOf(':');
    if (colon === -1) continue;
    const key = line.slice(0, colon).trim();
    let val = line.slice(colon + 1).trim();

    // Strip surrounding quotes
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }

    // Simple array: [a, b, c]
    if (val.startsWith('[') && val.endsWith(']')) {
      data[key] = val.slice(1, -1).split(',').map(s => s.trim().replace(/^["']|["']$/g, ''));
    } else {
      data[key] = val;
    }
  }

  return { data, content: match[2] };
}

function readingTime(text) {
  const words = text.trim().split(/\s+/).length;
  return Math.max(1, Math.round(words / 200));
}

function excerpt(content, length = 200) {
  const stripped = content.replace(/#+\s/g, '').replace(/[*_`[\]]/g, '').replace(/\n+/g, ' ').trim();
  return stripped.length > length ? stripped.slice(0, length).trimEnd() + '…' : stripped;
}

if (!fs.existsSync(postsDir)) {
  fs.mkdirSync(postsDir, { recursive: true });
  console.log('Created public/posts/ — add markdown files there.');
}

const files = fs.readdirSync(postsDir)
  .filter(f => f.endsWith('.md'))
  .sort()
  .reverse(); // newest first (relies on date-prefixed filenames)

const posts = [];

for (const file of files) {
  const slug = file.replace(/\.md$/, '');
  const raw = fs.readFileSync(path.join(postsDir, file), 'utf-8');
  const { data, content } = parseFrontmatter(raw);

  // Resolve thumbnail: full URLs pass through; relative paths (starting with /)
  // get the NEXT_PUBLIC_CUSTOM_BASE_PATH prepended so static exports work.
  const BASE = process.env.NEXT_PUBLIC_CUSTOM_BASE_PATH || '';
  let thumbnail = data.thumbnail || null;
  if (thumbnail && !thumbnail.startsWith('http://') && !thumbnail.startsWith('https://')) {
    thumbnail = BASE + thumbnail;
  }

  posts.push({
    slug,
    title: data.title || slug,
    date: data.date || '',
    author: data.author || 'Pulsar Team',
    tags: Array.isArray(data.tags) ? data.tags : data.tags ? [data.tags] : [],
    description: data.description || excerpt(content),
    readingTime: readingTime(content),
    thumbnail,
    draft: data.draft === 'true',
  });
}

// Exclude drafts from index (still built as pages, just not listed)
const published = posts.filter(p => !p.draft);

// Collect all unique tags, sorted by frequency (most posts first), then alphabetically
const tagCounts = {};
for (const p of published) {
  for (const t of p.tags) {
    tagCounts[t] = (tagCounts[t] || 0) + 1;
  }
}
const allTags = Object.keys(tagCounts).sort((a, b) => {
  const diff = tagCounts[b] - tagCounts[a];
  return diff !== 0 ? diff : a.localeCompare(b);
});

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || '';
const BASE = process.env.NEXT_PUBLIC_CUSTOM_BASE_PATH || '';

function resolveUrl(relativePath) {
  if (!relativePath) return null;
  if (relativePath.startsWith('http://') || relativePath.startsWith('https://')) return relativePath;
  if (!SITE_URL) return relativePath;
  return `${SITE_URL}${relativePath}`;
}

// Build external-facing post format with absolute URLs
const externalPosts = published.map(p => ({
  slug: p.slug,
  title: p.title,
  url: resolveUrl(`${BASE}/posts/${p.slug}`),
  date: p.date,
  author: p.author,
  tags: p.tags,
  description: p.description,
  readingTime: p.readingTime,
  thumbnail: resolveUrl(p.thumbnail),
  draft: p.draft,
}));

const index = {
  posts: published,
  allTags,
  tagFreq: tagCounts,
  total: published.length,
  generated: new Date().toISOString(),
};

fs.writeFileSync(indexFile, JSON.stringify(index, null, 2));
console.log(`Generated blog-index.json — ${published.length} posts, ${allTags.length} tags`);

// Write blog-all.json — all published posts with absolute URLs
fs.writeFileSync(allFile, JSON.stringify(externalPosts, null, 2));
console.log(`Generated blog-all.json — ${externalPosts.length} posts with absolute URLs`);

// Write blog-preview.json — top 5 most recent with absolute URLs
const previewPosts = externalPosts.slice(0, 5);
fs.writeFileSync(previewFile, JSON.stringify(previewPosts, null, 2));
console.log(`Generated blog-preview.json — ${previewPosts.length} posts (top 5)`);
