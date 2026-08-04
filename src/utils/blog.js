import fs from 'fs';
import path from 'path';
import GithubSlugger from 'github-slugger';

const postsDir = path.join(process.cwd(), 'public/posts');
const indexFile = path.join(process.cwd(), 'public/blog-index.json');

export function getBlogIndex() {
  const raw = fs.readFileSync(indexFile, 'utf-8');
  return JSON.parse(raw);
}

export function getPostSlugs() {
  const { posts } = getBlogIndex();
  return posts.map(p => p.slug);
}

export function getPostMeta(slug) {
  const { posts } = getBlogIndex();
  return posts.find(p => p.slug === slug) ?? null;
}

function parseFrontmatter(raw) {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) return { data: {}, content: raw };

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
  return { data, content: match[2] };
}

function normalizeMathBackslashes(content) {
  const lines = content.split('\n');
  const out = [];
  let inCode = false;
  let inMath = false;

  for (const line of lines) {
    // Track code fences
    if (/^```/.test(line)) { inCode = !inCode; out.push(line); continue; }

    if (!inCode) {
      // Track fenced math blocks ($$ on its own line)
      if (/^\s*\$\$\s*$/.test(line)) {
        inMath = !inMath;
        out.push(inMath ? '$$' : '$$');
        continue;
      }

      if (inMath) {
        // Inside fenced math: replace \\ with \
        out.push(line.replace(/\\\\/g, '\\'));
        continue;
      }

      // Outside both: fix inline math spans ($$...$$ and $...$)
      // Replace \\ with \ inside $$...$$ spans (single-line display math)
      let fixed = line.replace(/\$\$(.+?)\$\$/g, (_, inner) => '$$' + inner.replace(/\\\\/g, '\\') + '$$');
      // Replace \\ with \ inside $...$ spans (inline math)
      fixed = fixed.replace(/\$(.+?)\$/g, (_, inner) => '$' + inner.replace(/\\\\/g, '\\') + '$');
      out.push(fixed);
    } else {
      out.push(line);
    }
  }

  return out.join('\n');
}

export function getPostContent(slug) {
  let filePath = path.join(postsDir, `${slug}.md`);
  if (!fs.existsSync(filePath)) {
    filePath = path.join(postsDir, slug, 'index.md');
    if (!fs.existsSync(filePath)) return null;
  }
  const raw = fs.readFileSync(filePath, 'utf-8');
  const { content } = parseFrontmatter(raw);
  return normalizeMathBackslashes(content);
}

const slugger = new GithubSlugger();

export function extractHeadings(content) {
  slugger.reset();
  const lines = content.split('\n');
  const headings = [];

  for (const line of lines) {
    const match = line.match(/^(#{2,4})\s+(.+)/);
    if (!match) continue;
    const level = match[1].length;
    const text = match[2].trim();
    const id = slugger.slug(text);
    headings.push({ id, text, level });
  }

  return headings;
}
