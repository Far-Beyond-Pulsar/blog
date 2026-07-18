import fs from 'fs';
import path from 'path';

const authorsFile = path.join(process.cwd(), 'public/authors.json');

export interface AuthorData {
  login: string;
  name: string;
  avatar_url: string;
  html_url: string;
  bio?: string;
}

let _cache: Record<string, AuthorData> | null = null;

function loadCache(): Record<string, AuthorData> {
  if (_cache) return _cache;
  try {
    const raw = fs.readFileSync(authorsFile, 'utf-8');
    _cache = JSON.parse(raw);
  } catch {
    _cache = {};
  }
  return _cache!;
}

/** Resolve an array of GitHub usernames to AuthorData[]. */
export function getAuthors(usernames: string | string[]): AuthorData[] {
  const cache = loadCache();
  const names = Array.isArray(usernames) ? usernames : [usernames];
  return names
    .map((u) => cache[u] || { login: u, name: u, avatar_url: '', html_url: `https://github.com/${u}`, bio: '' })
    .filter((a) => a.login);
}
