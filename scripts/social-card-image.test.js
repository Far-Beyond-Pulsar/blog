const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');
const sharp = require('sharp');

const generator = path.join(__dirname, 'generate-blog-index.js');

test('generates separate social cards only for oversized local thumbnails', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'blog-social-card-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const posts = path.join(root, 'public', 'posts');
  fs.mkdirSync(posts, { recursive: true });

  const source = path.join(root, 'public', 'large.png');
  const pixels = crypto.randomBytes(1400 * 1400 * 3);
  await sharp(pixels, {
    raw: { width: 1400, height: 1400, channels: 3 },
  }).png().toFile(source);
  await sharp(pixels, {
    raw: { width: 1400, height: 1400, channels: 3 },
  }).tiff({ compression: 'none' }).toFile(path.join(root, 'public', 'large.tiff'));
  assert.ok(fs.statSync(source).size >= 5_000_000);
  const original = fs.readFileSync(source);
  await sharp({ create: { width: 20, height: 10, channels: 3, background: '#123456' } })
    .png().toFile(path.join(root, 'public', 'small.png'));
  for (const [slug, thumbnail] of [
    ['large', '/large.png'],
    ['tiff', '/large.tiff'],
    ['small', '/small.png'],
    ['remote', 'https://example.com/image.png'],
  ]) {
    fs.writeFileSync(path.join(posts, `${slug}.md`), `---\ntitle: ${slug}\nthumbnail: ${thumbnail}\n---\nContent`);
  }

  const run = () => spawnSync(process.execPath, [generator], {
    cwd: root,
    env: { ...process.env, NEXT_PUBLIC_CUSTOM_BASE_PATH: '/blog', NEXT_PUBLIC_SITE_URL: 'https://example.com' },
    encoding: 'utf8',
  });
  const result = run();
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stderr, /over the 5 MB limit/);
  const index = JSON.parse(fs.readFileSync(path.join(root, 'public', 'blog-index.json')));
  const large = index.posts.find(post => post.slug === 'large');
  assert.equal(large.thumbnail, '/blog/large.png');
  assert.match(large.socialThumbnail, /^\/blog\/social-cards\/large-[0-9a-f]{16}\.jpg$/);
  const cardPath = path.join(root, 'public', large.socialThumbnail.slice('/blog/'.length));
  assert.ok(fs.statSync(cardPath).size < 5_000_000);
  const card = await sharp(cardPath).metadata();
  assert.equal(card.format, 'jpeg');
  assert.equal(card.width, large.socialThumbnailWidth);
  assert.equal(card.height, large.socialThumbnailHeight);
  assert.deepEqual(fs.readFileSync(source), original);
  assert.equal(index.posts.find(post => post.slug === 'small').socialThumbnail, undefined);
  assert.equal(index.posts.find(post => post.slug === 'remote').socialThumbnail, undefined);
  const tiff = index.posts.find(post => post.slug === 'tiff');
  assert.ok(tiff.socialThumbnail);
  assert.ok(fs.statSync(path.join(root, 'public', tiff.socialThumbnail.slice('/blog/'.length))).size < 5_000_000);
  const oembed = JSON.parse(fs.readFileSync(path.join(root, 'public', 'oembed', 'large.json')));
  assert.equal(oembed.thumbnail_url, 'https://example.com/blog/large.png');

  const second = run();
  assert.equal(second.status, 0, second.stderr);
  const nextIndex = JSON.parse(fs.readFileSync(path.join(root, 'public', 'blog-index.json')));
  assert.equal(nextIndex.posts.find(post => post.slug === 'large').socialThumbnail, large.socialThumbnail);
});

test('fails explicitly when an oversized image cannot be decoded', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'blog-social-card-invalid-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const posts = path.join(root, 'public', 'posts');
  fs.mkdirSync(posts, { recursive: true });
  const invalid = Buffer.alloc(5_000_000);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(invalid);
  invalid.writeUInt32BE(10, 16);
  invalid.writeUInt32BE(10, 20);
  fs.writeFileSync(path.join(root, 'public', 'invalid.png'), invalid);
  fs.writeFileSync(path.join(posts, 'invalid.md'), '---\nthumbnail: /invalid.png\n---\nContent');
  const result = spawnSync(process.execPath, [generator], { cwd: root, encoding: 'utf8' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Failed to generate blog index/);
});
