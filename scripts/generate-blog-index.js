/**
 * Reads all markdown posts from public/posts/, extracts frontmatter,
 * computes reading time, writes blog-index.json, blog-preview.json, and blog-all.json.
 *
 * Post filenames become slugs: "2024-01-15-helio-renderer.md" → "2024-01-15-helio-renderer"
 */

const fs = require('fs');
const path = require('path');
const readingTime = require('reading-time');

const postsDir = path.join(process.cwd(), 'public/posts');
const indexFile = path.join(process.cwd(), 'public/blog-index.json');
const previewFile = path.join(process.cwd(), 'public/blog-preview.json');
const allFile = path.join(process.cwd(), 'public/blog-all.json');
const authorsFile = path.join(process.cwd(), 'public/authors.json');

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

function excerpt(content, length = 200) {
  const stripped = content.replace(/#+\s/g, '').replace(/[*_`[\]]/g, '').replace(/\n+/g, ' ').trim();
  return stripped.length > length ? stripped.slice(0, length).trimEnd() + '…' : stripped;
}

/**
 * Read intrinsic pixel dimensions from an image file header.
 *
 * Emitted as og:image:width / og:image:height so Slack, LinkedIn and Discord
 * can lay the card out before the image finishes downloading. Returns null for
 * formats we don't parse — omitting the tags is fine, wrong values are not.
 */
function imageSize(absPath) {
  let fd;
  try {
    fd = fs.openSync(absPath, 'r');
    const buf = Buffer.alloc(65536);
    const read = fs.readSync(fd, buf, 0, 65536, 0);
    if (read < 16) return null;

    // PNG: 8-byte signature, then IHDR with width/height at fixed offsets.
    if (buf.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
      return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
    }

    // GIF87a / GIF89a: little-endian dimensions in the logical screen descriptor.
    if (buf.slice(0, 3).toString('ascii') === 'GIF') {
      return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
    }

    // WebP: RIFF container, dimensions depend on the VP8 chunk variant.
    if (buf.slice(0, 4).toString('ascii') === 'RIFF' && buf.slice(8, 12).toString('ascii') === 'WEBP') {
      const chunk = buf.slice(12, 16).toString('ascii');
      if (chunk === 'VP8X') {
        return {
          width: 1 + (buf.readUIntLE(24, 3) & 0xffffff),
          height: 1 + (buf.readUIntLE(27, 3) & 0xffffff),
        };
      }
      if (chunk === 'VP8 ') {
        return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
      }
      if (chunk === 'VP8L') {
        const bits = buf.readUInt32LE(21);
        return { width: 1 + (bits & 0x3fff), height: 1 + ((bits >> 14) & 0x3fff) };
      }
      return null;
    }

    // JPEG: walk the marker chain to the start-of-frame segment.
    if (buf[0] === 0xff && buf[1] === 0xd8) {
      let i = 2;
      while (i < read - 9) {
        if (buf[i] !== 0xff) { i++; continue; }
        const marker = buf[i + 1];
        // SOF0-SOF15, excluding the non-frame markers DHT/JPG/DAC.
        if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
          return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
        }
        if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; }
        i += 2 + buf.readUInt16BE(i + 2);
      }
    }
    return null;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) try { fs.closeSync(fd); } catch {}
  }
}

if (!fs.existsSync(postsDir)) {
  fs.mkdirSync(postsDir, { recursive: true });
  console.log('Created public/posts/ — add markdown files there.');
}

const entries = fs.readdirSync(postsDir, { withFileTypes: true });
const files = [];
for (const entry of entries) {
  if (entry.name.endsWith('.md')) {
    files.push(entry.name); // flat file
  } else if (entry.isDirectory() && fs.existsSync(path.join(postsDir, entry.name, 'index.md'))) {
    files.push(entry.name + '/index.md'); // folder post
  }
}

function readFileContent(file) {
  return fs.readFileSync(path.join(postsDir, file), 'utf-8');
}

function slugFromFile(file) {
  return file.endsWith('/index.md') ? file.replace(/\/index\.md$/, '') : file.replace(/\.md$/, '');
}

function dateFromFile(file) {
  const raw = readFileContent(file);
  return parseFrontmatter(raw).data.date || slugFromFile(file).split('-').slice(0, 3).join('-');
}

files.sort((a, b) => dateFromFile(b).localeCompare(dateFromFile(a)));

const posts = [];

for (const file of files) {
  const slug = slugFromFile(file);
  const raw = readFileContent(file);
  const { data, content } = parseFrontmatter(raw);

  // Resolve thumbnail: full URLs pass through; relative paths (starting with /)
  // get the NEXT_PUBLIC_CUSTOM_BASE_PATH prepended so static exports work.
  const BASE = process.env.NEXT_PUBLIC_CUSTOM_BASE_PATH || '';
  let thumbnail = data.thumbnail || null;
  let thumbnailWidth = null;
  let thumbnailHeight = null;
  if (thumbnail && !thumbnail.startsWith('http://') && !thumbnail.startsWith('https://')) {
    if (file.endsWith('/index.md') && thumbnail.startsWith('./')) {
      thumbnail = `/posts/${slug}/` + thumbnail.slice(2);
    }
    // Probe the file on disk before the base path is applied — the base is a
    // URL concern, the file lives under public/ either way.
    const dims = imageSize(path.join(process.cwd(), 'public', thumbnail));
    if (dims) {
      thumbnailWidth = dims.width;
      thumbnailHeight = dims.height;
    } else {
      console.warn(`  ! ${slug}: thumbnail "${thumbnail}" not found or unreadable — card will have no image dimensions`);
    }
    thumbnail = BASE + thumbnail;
  }

  // Resolve author data from cache
  let authorsCache = {};
  try { authorsCache = JSON.parse(fs.readFileSync(authorsFile, 'utf-8')); } catch {}
  const rawAuthors = Array.isArray(data.author) ? data.author : (data.author ? [data.author] : []);
  const authorData = rawAuthors.map(u => authorsCache[u] || { login: u, name: u, avatar_url: '', html_url: `https://github.com/${u}`, bio: '' }).filter(a => a.login);

  const rt = readingTime(content);
  posts.push({
    slug,
    title: data.title || slug,
    date: data.date || '',
    author: rawAuthors,
    authorData,
    tags: Array.isArray(data.tags) ? data.tags : data.tags ? [data.tags] : [],
    description: data.description || excerpt(content),
    readingTime: Math.max(1, Math.round(rt.minutes)),
    wordCount: rt.words,
    thumbnail,
    thumbnailWidth,
    thumbnailHeight,
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

// Collect all unique authors with post counts
const authorCounts = {};
for (const p of published) {
  for (const a of (p.authorData || [])) {
    const key = a.login;
    if (!authorCounts[key]) authorCounts[key] = { ...a, count: 0 };
    authorCounts[key].count++;
  }
}
const allAuthors = Object.values(authorCounts).sort((a, b) => b.count - a.count);

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
  url: resolveUrl(`${BASE}/${p.slug}`),
  date: p.date,
  author: p.author,
  tags: p.tags,
  description: p.description,
  readingTime: p.readingTime,
  wordCount: p.wordCount,
  thumbnail: resolveUrl(p.thumbnail),
  draft: p.draft,
}));

const index = {
  posts: published,
  allTags,
  tagFreq: tagCounts,
  allAuthors,
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

// ── Social card assets ──────────────────────────────────────────────────────

/**
 * One oEmbed document per post.
 *
 * Discord discovers these through the <link rel="alternate"
 * type="application/json+oembed"> tag the post page emits, and uses
 * author_name / author_url to draw the byline above the embed title. Nothing
 * else consumes them, so the shape stays minimal and type "link".
 */
const oembedDir = path.join(process.cwd(), 'public/oembed');
fs.mkdirSync(oembedDir, { recursive: true });

for (const p of published) {
  const primaryAuthor = (p.authorData || [])[0];
  const doc = {
    type: 'link',
    version: '1.0',
    title: p.title,
    provider_name: 'Pulsar Blog',
    provider_url: resolveUrl(`${BASE}/`) || `${BASE}/`,
  };
  if (primaryAuthor) {
    const names = (p.authorData || []).map(a => a.name || a.login);
    doc.author_name = names.length > 1 ? `${names[0]} +${names.length - 1}` : names[0];
    doc.author_url = primaryAuthor.html_url;
  }
  const thumb = resolveUrl(p.thumbnail);
  if (thumb) {
    doc.thumbnail_url = thumb;
    if (p.thumbnailWidth && p.thumbnailHeight) {
      doc.thumbnail_width = p.thumbnailWidth;
      doc.thumbnail_height = p.thumbnailHeight;
    }
  }
  fs.writeFileSync(path.join(oembedDir, `${p.slug}.json`), JSON.stringify(doc, null, 2));
}
console.log(`Generated oembed/ — ${published.length} documents`);

/**
 * Warn on thumbnails that will not survive a scraper.
 *
 * These are advisory, not fatal — the card still renders, it just falls back to
 * a bare link on the platforms whose limits the image blows past. Silent
 * failure here is the norm, so it is worth being loud at build time.
 *
 * Limits: X and LinkedIn reject over 5 MB; Discord and Facebook allow 8 MB.
 * Discord will not proxy an image wider than 4096px.
 */
const MAX_CARD_BYTES = 5 * 1024 * 1024;
const MAX_CARD_EDGE = 4096;
const warnings = [];

for (const p of published) {
  if (!p.thumbnail) {
    warnings.push(`${p.slug}: no thumbnail — shared links fall back to the site default card`);
    continue;
  }
  if (/^https?:\/\//i.test(p.thumbnail)) continue; // remote, can't inspect

  const rel = BASE && p.thumbnail.startsWith(BASE) ? p.thumbnail.slice(BASE.length) : p.thumbnail;
  const abs = path.join(process.cwd(), 'public', rel);
  let bytes = 0;
  try { bytes = fs.statSync(abs).size; } catch {
    warnings.push(`${p.slug}: thumbnail "${rel}" does not exist on disk — card will have no image`);
    continue;
  }
  if (bytes > MAX_CARD_BYTES) {
    warnings.push(`${p.slug}: thumbnail is ${(bytes / 1024 / 1024).toFixed(1)} MB — over the 5 MB limit on X and LinkedIn, those cards will render without an image`);
  }
  if (p.thumbnailWidth > MAX_CARD_EDGE || p.thumbnailHeight > MAX_CARD_EDGE) {
    warnings.push(`${p.slug}: thumbnail is ${p.thumbnailWidth}x${p.thumbnailHeight} — over Discord's 4096px proxy limit`);
  }
}

if (warnings.length) {
  console.warn(`\nSocial card warnings (${warnings.length}):`);
  for (const w of warnings) console.warn(`  ! ${w}`);
  console.warn('');
}
