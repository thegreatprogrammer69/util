const http = require('http');
const path = require('path');
const fs = require('fs/promises');
const fsSync = require('fs');
const { URL } = require('url');

const PORT = Number(process.env.PORT || 3000);
const ROOT_DIR = path.resolve(process.env.ROOT_DIR || path.join(__dirname, 'root'));
const PUBLIC_DIR = path.join(__dirname, 'public');

fsSync.mkdirSync(ROOT_DIR, { recursive: true });

function json(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}

function safePath(relativePath = '/') {
  const normalized = String(relativePath).replace(/\\/g, '/');
  const withoutLeading = normalized.replace(/^\/+/, '');
  const resolved = path.resolve(ROOT_DIR, withoutLeading);
  if (!resolved.startsWith(ROOT_DIR)) {
    throw new Error('Path escapes root');
  }
  return resolved;
}

function relativeFromRoot(absPath) {
  const rel = path.relative(ROOT_DIR, absPath).replace(/\\/g, '/');
  return rel ? `/${rel}` : '/';
}

async function buildTree(dirAbs = ROOT_DIR) {
  const entries = await fs.readdir(dirAbs, { withFileTypes: true });
  entries.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));
  const children = [];
  for (const entry of entries) {
    const abs = path.join(dirAbs, entry.name);
    const rel = relativeFromRoot(abs);
    if (entry.isDirectory()) {
      children.push({ id: rel, text: entry.name, type: 'directory', children: await buildTree(abs) });
    } else {
      children.push({ id: rel, text: entry.name, type: 'file', children: false });
    }
  }
  return children;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function readJson(req) {
  const text = await readBody(req);
  return text ? JSON.parse(text) : {};
}

function countCapturingGroups(pattern) {
  let count = 0;
  let escaped = false;
  let inClass = false;
  for (let i = 0; i < pattern.length; i += 1) {
    const ch = pattern[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === '\\') {
      escaped = true;
      continue;
    }
    if (ch === '[') inClass = true;
    if (ch === ']') inClass = false;
    if (inClass) continue;
    if (ch === '(' && pattern.slice(i, i + 2) !== '(?') count += 1;
  }
  return count;
}

async function listFilesRecursively(startDir) {
  const files = [];
  const entries = await fs.readdir(startDir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(startDir, entry.name);
    if (entry.isDirectory()) files.push(...await listFilesRecursively(full));
    else files.push(full);
  }
  return files;
}

function sendFile(res, filePath) {
  const stream = fsSync.createReadStream(filePath);
  stream.on('error', () => json(res, 404, { error: 'Not found' }));
  stream.pipe(res);
}

async function handleApi(req, res, url) {
  try {
    if (req.method === 'GET' && url.pathname === '/api/tree') {
      return json(res, 200, { root: '/', children: await buildTree(ROOT_DIR) });
    }

    if (req.method === 'POST' && url.pathname === '/api/upload') {
      const body = await readJson(req);
      const targetDirAbs = safePath(body.targetDir || '/');
      await fs.mkdir(targetDirAbs, { recursive: true });
      for (const file of body.files || []) {
        if (!file.name || /[\\/]/.test(file.name)) throw new Error('Invalid file name');
        const target = path.join(targetDirAbs, file.name);
        await fs.writeFile(target, Buffer.from(file.contentBase64 || '', 'base64'));
      }
      return json(res, 200, { success: true });
    }

    if (req.method === 'POST' && url.pathname === '/api/folder') {
      const body = await readJson(req);
      if (!body.name || /[\\/]/.test(body.name)) return json(res, 400, { error: 'Invalid folder name' });
      await fs.mkdir(safePath(path.posix.join(body.parentDir || '/', body.name)), { recursive: true });
      return json(res, 200, { success: true });
    }

    if (req.method === 'PATCH' && url.pathname === '/api/rename') {
      const body = await readJson(req);
      if (!body.toName || /[\\/]/.test(body.toName)) return json(res, 400, { error: 'Invalid new name' });
      const fromAbs = safePath(body.from);
      const toAbs = path.join(path.dirname(fromAbs), body.toName);
      if (!toAbs.startsWith(ROOT_DIR)) return json(res, 400, { error: 'Invalid target path' });
      await fs.rename(fromAbs, toAbs);
      return json(res, 200, { success: true, path: relativeFromRoot(toAbs) });
    }

    if (req.method === 'DELETE' && url.pathname === '/api/item') {
      const abs = safePath(url.searchParams.get('path') || '/');
      if (abs === ROOT_DIR) return json(res, 400, { error: 'Cannot delete root directory' });
      await fs.rm(abs, { recursive: true, force: true });
      return json(res, 200, { success: true });
    }

    if (req.method === 'POST' && url.pathname === '/api/move') {
      const body = await readJson(req);
      const fromAbs = safePath(body.from);
      const toAbs = path.join(safePath(body.toDir), path.basename(fromAbs));
      if (!toAbs.startsWith(ROOT_DIR)) return json(res, 400, { error: 'Invalid move target' });
      await fs.rename(fromAbs, toAbs);
      return json(res, 200, { success: true, path: relativeFromRoot(toAbs) });
    }

    if (req.method === 'GET' && url.pathname === '/api/download') {
      const abs = safePath(url.searchParams.get('path') || '/');
      const stat = await fs.stat(abs);
      if (!stat.isFile()) return json(res, 400, { error: 'Only files can be downloaded' });
      res.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'Content-Disposition': `attachment; filename="${path.basename(abs)}"`,
      });
      return sendFile(res, abs);
    }

    if (req.method === 'POST' && url.pathname === '/api/process') {
      const body = await readJson(req);
      const sourceAbs = safePath(body.sourceDir || '/');
      const outAbs = safePath(body.outputFile || '/result.txt');
      const filter = body.filterRegex ? new RegExp(body.filterRegex) : null;
      const rules = (body.rules || []).map((rule) => {
        if (!rule.name || !/^[_a-zA-Z][_a-zA-Z0-9]*$/.test(rule.name)) throw new Error(`Invalid rule name: ${rule.name}`);
        if (countCapturingGroups(rule.regex || '') !== 1) throw new Error(`Rule "${rule.name}" must contain exactly one capturing group`);
        return { name: rule.name, regex: new RegExp(rule.regex) };
      });

      const files = await listFilesRecursively(sourceAbs);
      const output = [];
      let linesSeen = 0;

      for (const filePath of files) {
        const lines = (await fs.readFile(filePath, 'utf8')).split(/\r?\n/);
        for (const line of lines) {
          if (!line) continue;
          linesSeen += 1;
          if (filter) {
            const ok = filter.test(line);
            if ((body.filterMode === 'exclude' && ok) || (body.filterMode !== 'exclude' && !ok)) continue;
          }
          const values = {};
          let valid = true;
          for (const rule of rules) {
            const m = line.match(rule.regex);
            if (!m || m.length < 2) {
              valid = false;
              break;
            }
            values[rule.name] = m[1];
          }
          if (!valid) continue;
          output.push(String(body.template || '').replace(/\{([_a-zA-Z][_a-zA-Z0-9]*)\}/g, (_, k) => values[k] ?? `{${k}}`));
        }
      }

      await fs.mkdir(path.dirname(outAbs), { recursive: true });
      await fs.writeFile(outAbs, output.join('\n') + (output.length ? '\n' : ''), 'utf8');
      return json(res, 200, { success: true, linesSeen, linesProduced: output.length, output: relativeFromRoot(outAbs) });
    }

    return json(res, 404, { error: 'Not found' });
  } catch (error) {
    return json(res, 400, { error: error.message });
  }
}

const contentTypes = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (url.pathname.startsWith('/api/')) {
    return handleApi(req, res, url);
  }

  const requestedPath = url.pathname === '/' ? '/index.html' : url.pathname;
  const resolved = path.resolve(PUBLIC_DIR, `.${requestedPath}`);
  if (!resolved.startsWith(PUBLIC_DIR)) return json(res, 403, { error: 'Forbidden' });

  try {
    const stat = await fs.stat(resolved);
    if (!stat.isFile()) return json(res, 404, { error: 'Not found' });
    res.writeHead(200, { 'Content-Type': contentTypes[path.extname(resolved)] || 'application/octet-stream' });
    sendFile(res, resolved);
  } catch {
    json(res, 404, { error: 'Not found' });
  }
});

server.listen(PORT, '0.0.0.0', () => {
  // eslint-disable-next-line no-console
  console.log(`Server started on http://0.0.0.0:${PORT}, root dir: ${ROOT_DIR}`);
});
