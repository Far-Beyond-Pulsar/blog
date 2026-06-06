/**
 * Reads all markdown posts from public/posts/, extracts frontmatter,
 * computes reading time, and writes public/blog-index.json.
 *
 * Post filenames become slugs: "2024-01-15-helio-renderer.md" → "2024-01-15-helio-renderer"
 */

const fs = require('fs');
const path = require('path');

const postsDir = path.join(process.cwd(), 'public/posts');
const outputFile = path.join(process.cwd(), 'public/blog-index.json');

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

  posts.push({
    slug,
    title: data.title || slug,
    date: data.date || '',
    author: data.author || 'Pulsar Team',
    tags: Array.isArray(data.tags) ? data.tags : data.tags ? [data.tags] : [],
    description: data.description || excerpt(content),
    readingTime: readingTime(content),
    draft: data.draft === 'true',
  });
}

// Exclude drafts from index (still built as pages, just not listed)
const published = posts.filter(p => !p.draft);

// Collect all unique tags
const allTags = [...new Set(published.flatMap(p => p.tags))].sort();

const index = {
  posts: published,
  allTags,
  total: published.length,
  generated: new Date().toISOString(),
};

fs.writeFileSync(outputFile, JSON.stringify(index, null, 2));
console.log(`Generated blog-index.json — ${published.length} posts, ${allTags.length} tags`);
