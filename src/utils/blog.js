import fs from 'fs';
import path from 'path';

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

export function getPostContent(slug) {
  const filePath = path.join(postsDir, `${slug}.md`);
  if (!fs.existsSync(filePath)) return null;

  const raw = fs.readFileSync(filePath, 'utf-8');
  const { content } = parseFrontmatter(raw);
  return content;
}

export function extractHeadings(content) {
  const lines = content.split('\n');
  const headings = [];

  for (const line of lines) {
    const match = line.match(/^(#{2,4})\s+(.+)/);
    if (!match) continue;
    const level = match[1].length;
    const text = match[2].trim();
    const id = text
      .toLowerCase()
      .replace(/[^\w\s-]/g, '')
      .replace(/\s+/g, '-')
      .replace(/-+/g, '-');
    headings.push({ id, text, level });
  }

  return headings;
}
