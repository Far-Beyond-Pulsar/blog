const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

// Use the stricter decimal interpretation of 5 MB, and stay below it.
const MAX_CARD_BYTES = 5_000_000;

async function createSocialCard(source, outputDir, slug) {
  const input = fs.readFileSync(source);
  let edge = 2048;

  while (edge >= 1) {
    const { data, info } = await sharp(input)
      .rotate()
      .resize({ width: edge, height: edge, fit: 'inside', withoutEnlargement: true })
      .flatten({ background: '#ffffff' })
      .jpeg({ quality: 85, mozjpeg: true })
      .toBuffer({ resolveWithObject: true });

    if (data.length < MAX_CARD_BYTES) {
      const hash = crypto.createHash('sha256').update(data).digest('hex').slice(0, 16);
      const filename = `${slug}-${hash}.jpg`;
      fs.mkdirSync(outputDir, { recursive: true });
      fs.writeFileSync(path.join(outputDir, filename), data);
      return { filename, width: info.width, height: info.height };
    }
    if (edge === 1) break;
    edge = Math.max(1, Math.floor(edge / 2));
  }
  throw new Error(`Could not compress social card for ${slug} below ${MAX_CARD_BYTES} bytes`);
}

module.exports = { createSocialCard, MAX_CARD_BYTES };
