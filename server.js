const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs/promises');
const fsSync = require('fs');
const mime = require('mime-types');

const app = express();
const PORT = process.env.PORT || 3000;
const ROOT_DIR = path.resolve(process.env.ROOT_DIR || path.join(__dirname, 'root'));

const ensureRoot = async () => {
  await fs.mkdir(ROOT_DIR, { recursive: true });
};

const sanitizeRelativePath = (inputPath = '') => {
  const normalized = path.posix.normalize(`/${String(inputPath).replace(/\\/g, '/')}`);
  if (normalized.includes('..')) {
    throw new Error('Недопустимый путь');
  }
  return normalized === '/' ? '' : normalized.slice(1);
};

const toAbsolutePath = (inputPath = '') => {
  const relPath = sanitizeRelativePath(inputPath);
  const abs = path.resolve(ROOT_DIR, relPath);
  if (!abs.startsWith(ROOT_DIR)) {
    throw new Error('Выход за пределы root запрещен');
  }
  return { relPath, abs };
};

const buildTree = async (dirAbs, dirRel = '') => {
  const entries = await fs.readdir(dirAbs, { withFileTypes: true });
  entries.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));

  const children = [];
  for (const entry of entries) {
    const childRel = path.posix.join(dirRel, entry.name);
    const childAbs = path.join(dirAbs, entry.name);
    if (entry.isDirectory()) {
      children.push({
        name: entry.name,
        type: 'directory',
        path: `/${childRel}`,
        children: await buildTree(childAbs, childRel)
      });
    } else {
      const stat = await fs.stat(childAbs);
      children.push({
        name: entry.name,
        type: 'file',
        path: `/${childRel}`,
        size: stat.size,
        updatedAt: stat.mtime.toISOString()
      });
    }
  }

  return children;
};

const storage = multer.diskStorage({
  destination: async (req, file, cb) => {
    try {
      const { abs } = toAbsolutePath(req.body.targetDir || '');
      await fs.mkdir(abs, { recursive: true });
      cb(null, abs);
    } catch (error) {
      cb(error);
    }
  },
  filename: (req, file, cb) => cb(null, file.originalname)
});
const upload = multer({ storage });

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/tree', async (_req, res) => {
  try {
    await ensureRoot();
    const tree = await buildTree(ROOT_DIR);
    res.json({ root: '/', children: tree });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/upload', upload.array('files'), async (_req, res) => {
  res.json({ ok: true });
});

app.post('/api/folder', async (req, res) => {
  try {
    const { dirPath, name } = req.body;
    if (!name || name.includes('/')) {
      return res.status(400).json({ error: 'Некорректное имя папки' });
    }
    const parent = toAbsolutePath(dirPath || '').abs;
    const folderAbs = path.join(parent, name);
    if (!folderAbs.startsWith(ROOT_DIR)) {
      return res.status(400).json({ error: 'Некорректный путь' });
    }
    await fs.mkdir(folderAbs, { recursive: false });
    res.json({ ok: true });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.post('/api/rename', async (req, res) => {
  try {
    const { path: oldPath, newName } = req.body;
    if (!newName || newName.includes('/')) {
      return res.status(400).json({ error: 'Некорректное новое имя' });
    }
    const { abs: oldAbs, relPath } = toAbsolutePath(oldPath);
    const newRel = path.posix.join(path.posix.dirname(relPath), newName);
    const { abs: newAbs } = toAbsolutePath(newRel);
    await fs.rename(oldAbs, newAbs);
    res.json({ ok: true });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.post('/api/delete', async (req, res) => {
  try {
    const { abs } = toAbsolutePath(req.body.path);
    await fs.rm(abs, { recursive: true, force: true });
    res.json({ ok: true });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.post('/api/move', async (req, res) => {
  try {
    const { srcPath, destDir } = req.body;
    const { abs: srcAbs } = toAbsolutePath(srcPath);
    const { abs: destAbs } = toAbsolutePath(destDir);
    const stat = await fs.stat(destAbs);
    if (!stat.isDirectory()) {
      return res.status(400).json({ error: 'destDir должен быть директорией' });
    }
    const fileName = path.basename(srcAbs);
    const target = path.join(destAbs, fileName);
    if (!target.startsWith(ROOT_DIR)) {
      return res.status(400).json({ error: 'Некорректный target путь' });
    }
    await fs.rename(srcAbs, target);
    res.json({ ok: true });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.get('/api/download', async (req, res) => {
  try {
    const { abs } = toAbsolutePath(req.query.path);
    const stat = await fs.stat(abs);
    if (!stat.isFile()) {
      return res.status(400).json({ error: 'Можно скачать только файл' });
    }
    const filename = path.basename(abs);
    res.setHeader('Content-Type', mime.lookup(filename) || 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`);
    fsSync.createReadStream(abs).pipe(res);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

const collectFilesRecursively = async (dirAbs) => {
  const result = [];
  const entries = await fs.readdir(dirAbs, { withFileTypes: true });
  for (const entry of entries) {
    const abs = path.join(dirAbs, entry.name);
    if (entry.isDirectory()) {
      result.push(...(await collectFilesRecursively(abs)));
    } else {
      result.push(abs);
    }
  }
  return result;
};

app.post('/api/process', async (req, res) => {
  try {
    const {
      inputDir,
      outputFile,
      includeRegex,
      includeMode = 'positive',
      mappings = [],
      template = ''
    } = req.body;

    const { abs: inputAbs } = toAbsolutePath(inputDir || '');
    const { abs: outputAbs } = toAbsolutePath(outputFile || '/result.txt');

    const inputStat = await fs.stat(inputAbs);
    if (!inputStat.isDirectory()) {
      return res.status(400).json({ error: 'inputDir должен быть директорией' });
    }

    const includeRe = includeRegex ? new RegExp(includeRegex) : null;
    const mappingRes = mappings.map((m) => ({
      key: m.key,
      regex: new RegExp(m.regex)
    }));

    const files = await collectFilesRecursively(inputAbs);
    const outputLines = [];

    for (const fileAbs of files) {
      const content = await fs.readFile(fileAbs, 'utf8');
      const lines = content.split(/\r?\n/);

      for (const line of lines) {
        if (!line) continue;
        if (includeRe) {
          const test = includeRe.test(line);
          if ((includeMode === 'positive' && !test) || (includeMode === 'negative' && test)) {
            continue;
          }
        }

        const values = {};
        let fullMatch = true;
        for (const { key, regex } of mappingRes) {
          const match = line.match(regex);
          if (!match || typeof match[1] === 'undefined') {
            fullMatch = false;
            break;
          }
          values[key] = match[1];
        }
        if (!fullMatch) continue;

        const out = template.replace(/\{([a-zA-Z0-9_]+)\}/g, (_m, groupKey) => values[groupKey] ?? '');
        outputLines.push(out);
      }
    }

    await fs.mkdir(path.dirname(outputAbs), { recursive: true });
    await fs.writeFile(outputAbs, outputLines.join('\n'), 'utf8');

    res.json({ ok: true, outputPath: outputFile, linesWritten: outputLines.length });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.listen(PORT, async () => {
  await ensureRoot();
  console.log(`Server running on http://localhost:${PORT}`);
  console.log(`ROOT_DIR=${ROOT_DIR}`);
});
