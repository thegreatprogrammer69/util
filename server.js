const express = require('express');
const multer = require('multer');
const fs = require('fs/promises');
const fssync = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const ROOT_DIR = path.resolve(process.env.ROOT_DIR || path.join(__dirname, 'root'));

if (!fssync.existsSync(ROOT_DIR)) {
  fssync.mkdirSync(ROOT_DIR, { recursive: true });
}

app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const upload = multer({ dest: path.join(__dirname, '.uploads') });

function resolveSafePath(relativePath = '/') {
  const clean = String(relativePath).replace(/\\/g, '/');
  const trimmed = clean.startsWith('/') ? clean.slice(1) : clean;
  const resolved = path.resolve(ROOT_DIR, trimmed);
  if (!resolved.startsWith(ROOT_DIR)) {
    throw new Error('Path escapes ROOT_DIR');
  }
  return resolved;
}

async function buildTree(currentPath, relative = '/') {
  const stat = await fs.stat(currentPath);
  const name = relative === '/' ? '/' : path.basename(currentPath);

  if (!stat.isDirectory()) {
    return {
      id: relative,
      text: name,
      type: 'file',
      children: false,
      li_attr: { 'data-path': relative }
    };
  }

  const entries = await fs.readdir(currentPath, { withFileTypes: true });
  const children = await Promise.all(
    entries
      .sort((a, b) => a.name.localeCompare(b.name))
      .map(async (entry) => {
        const childRelative = path.posix.join(relative === '/' ? '' : relative, entry.name);
        const childAbsolute = path.join(currentPath, entry.name);
        return buildTree(childAbsolute, `/${childRelative.replace(/^\//, '')}`);
      })
  );

  return {
    id: relative,
    text: name,
    type: 'folder',
    state: { opened: relative === '/' },
    children,
    li_attr: { 'data-path': relative }
  };
}

async function listFilesRecursive(dir) {
  const result = [];
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      result.push(...await listFilesRecursive(full));
    } else if (entry.isFile()) {
      result.push(full);
    }
  }
  return result;
}

app.get('/api/tree', async (req, res) => {
  try {
    const tree = await buildTree(ROOT_DIR, '/');
    res.json(tree);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/upload', upload.single('file'), async (req, res) => {
  try {
    const targetDir = resolveSafePath(req.body.targetDir || '/');
    await fs.mkdir(targetDir, { recursive: true });
    const target = path.join(targetDir, req.file.originalname);
    await fs.rename(req.file.path, target);
    res.json({ ok: true });
  } catch (error) {
    if (req.file?.path) {
      await fs.rm(req.file.path, { force: true });
    }
    res.status(400).json({ error: error.message });
  }
});

app.post('/api/create-folder', async (req, res) => {
  try {
    const parent = resolveSafePath(req.body.parent || '/');
    const folderName = req.body.name;
    if (!folderName || folderName.includes('/')) {
      throw new Error('Invalid folder name');
    }
    await fs.mkdir(path.join(parent, folderName), { recursive: false });
    res.json({ ok: true });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.post('/api/rename', async (req, res) => {
  try {
    const source = resolveSafePath(req.body.path);
    const newName = req.body.newName;
    if (!newName || newName.includes('/')) {
      throw new Error('Invalid new name');
    }
    const target = path.join(path.dirname(source), newName);
    if (!target.startsWith(ROOT_DIR)) {
      throw new Error('Invalid target');
    }
    await fs.rename(source, target);
    res.json({ ok: true });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.post('/api/move', async (req, res) => {
  try {
    const source = resolveSafePath(req.body.source);
    const destinationDir = resolveSafePath(req.body.destinationDir);
    const target = path.join(destinationDir, path.basename(source));
    await fs.rename(source, target);
    res.json({ ok: true });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.delete('/api/delete', async (req, res) => {
  try {
    const target = resolveSafePath(req.query.path);
    await fs.rm(target, { recursive: true, force: true });
    res.json({ ok: true });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.get('/api/download', async (req, res) => {
  try {
    const target = resolveSafePath(req.query.path);
    const stat = await fs.stat(target);
    if (!stat.isFile()) {
      throw new Error('Only files can be downloaded');
    }
    res.download(target);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.post('/api/process', async (req, res) => {
  try {
    const {
      inputDir,
      outputFile,
      filterRegex,
      filterMode = 'positive',
      patterns = [],
      template = ''
    } = req.body;

    const inDir = resolveSafePath(inputDir || '/');
    const outPath = resolveSafePath(outputFile || '/result.txt');

    const baseFilter = filterRegex ? new RegExp(filterRegex) : null;
    const compiledPatterns = patterns.map(({ key, regex }) => {
      if (!key || !regex) {
        throw new Error('Pattern key/regex required');
      }
      const re = new RegExp(regex);
      return { key, re };
    });

    const files = await listFilesRecursive(inDir);
    const outputLines = [];

    for (const file of files) {
      const content = await fs.readFile(file, 'utf8');
      const lines = content.split(/\r?\n/);
      for (const line of lines) {
        if (line === '') continue;

        if (baseFilter) {
          const matched = baseFilter.test(line);
          if ((filterMode === 'positive' && !matched) || (filterMode === 'negative' && matched)) {
            continue;
          }
        }

        const captures = {};
        let skip = false;
        for (const { key, re } of compiledPatterns) {
          const m = line.match(re);
          if (!m || m.length !== 2) {
            skip = true;
            break;
          }
          captures[key] = m[1];
        }
        if (skip) continue;

        const rendered = template.replace(/\{([a-zA-Z0-9_]+)\}/g, (_, name) => captures[name] ?? '');
        outputLines.push(rendered);
      }
    }

    await fs.mkdir(path.dirname(outPath), { recursive: true });
    await fs.writeFile(outPath, outputLines.join('\n'), 'utf8');

    res.json({ ok: true, lines: outputLines.length });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
  console.log(`ROOT_DIR=${ROOT_DIR}`);
});
