/**
 * Build /docs (deployable, uglified PWA) from /source (readable code).
 *   npm install && npm run build
 *
 * Follows the pwa-player convention: the source tree is walked recursively and
 * mirrored into /docs. Every HTML page becomes a directory route — an HTML
 * file named "xxx.html" is emitted as "docs/xxx/index.html" — so Cloudflare
 * Pages resolves "/xxx/" correctly. The root "index.html" stays at /docs/.
 */
import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir, copyFile, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { minify as terserMinify } from 'terser';
import { minify as htmlMinify } from 'html-minifier-terser';
import CleanCSS from 'clean-css';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = path.join(root, 'source');
const docs = path.join(root, 'docs');

await rm(docs, { recursive: true, force: true });
await mkdir(docs, { recursive: true });

const htmlOptions = {
  collapseWhitespace: true,
  collapseBooleanAttributes: true,
  removeComments: true,
  removeRedundantAttributes: true,
  removeEmptyAttributes: false,
  removeOptionalTags: true,
  useShortDoctype: true,
  decodeEntities: true,
  minifyJS: true,
  minifyCSS: true,
  sortAttributes: true,
  html5: true,
};

async function minifyJS(code) {
  const result = await terserMinify(code, {
    compress: { passes: 2, drop_console: true },
    mangle: { toplevel: true },
    format: { comments: false },
  });
  if (result.error) throw result.error;
  return result.code;
}

function minifyCSS(css) {
  const result = new CleanCSS({ level: 2, format: 'clean' }).minify(css);
  if (result.errors.length) throw new Error(result.errors.join('\n'));
  return result.styles;
}

// Where a source file lands in /docs. HTML files (other than the root page)
// become directory routes; icons are flattened into the app root.
function destinationFor(relPath) {
  if (relPath === 'manifest.json') return 'manifest.webmanifest';
  if (relPath.startsWith('icons' + path.sep)) return path.basename(relPath);
  if (!relPath.endsWith('.html')) return relPath;
  if (path.basename(relPath) === 'index.html') return relPath;
  const withoutExt = relPath.slice(0, -'.html'.length);
  return path.join(withoutExt, 'index.html');
}

async function write(destination, content) {
  const target = path.join(docs, destination);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, content);
  return Buffer.byteLength(content);
}

async function processFile(srcPath) {
  const relPath = path.relative(source, srcPath);
  const destination = destinationFor(relPath);
  const ext = path.extname(srcPath).toLowerCase();
  const content = await readFile(srcPath, 'utf8');

  if (ext === '.html') return write(destination, await htmlMinify(content, htmlOptions));
  if (ext === '.css') return write(destination, minifyCSS(content));
  if (ext === '.js') return write(destination, await minifyJS(content));
  if (ext === '.json' || destination === 'manifest.webmanifest') {
    return write(destination, JSON.stringify(JSON.parse(content)) + '\n');
  }
  await copyFile(srcPath, path.join(docs, destination));
  return (await readFile(path.join(docs, destination))).byteLength;
}

async function walk(dir) {
  const results = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const srcPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...await walk(srcPath));
    } else {
      results.push([destinationFor(path.relative(source, srcPath)), await processFile(srcPath)]);
    }
  }
  return results;
}

const built = await walk(source);

// Tie the service-worker cache name to the built assets so every deploy refreshes the cache.
const hash = createHash('sha256');
for (const file of ['index.html', 'help/index.html', 'styles.css', 'app.js', 'manifest.webmanifest']) {
  hash.update(await readFile(path.join(docs, file)));
  hash.update('\u0000');
}
const cacheRevision = hash.digest('hex').slice(0, 10);
const swPath = path.join(docs, 'sw.js');
const sw = (await readFile(swPath, 'utf8')).replace('fridge-v1', `fridge-${cacheRevision}`);
await writeFile(swPath, sw + '\n');

for (const [name, size] of built.sort((a, b) => a[0].localeCompare(b[0]))) {
  console.log(`${name.padEnd(28)} ${String(size).padStart(6)} bytes`);
}
console.log(`\nBuilt /docs with cache revision ${cacheRevision}.`);
