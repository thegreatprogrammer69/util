const express = require('express');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const multer = require('multer');
const mime = require('mime-types');

const app = express();
const PORT = process.env.PORT || 3000;
const ROOT_DIR = path.resolve(process.env.ROOT_DIR || path.join(process.cwd(), 'root'));

fs.mkdirSync(ROOT_DIR, { recursive: true });

app.use(express.json());
app.use(express.static(path.join(process.cwd(), 'public')));

const upload = multer({ storage: multer.memoryStorage() });

function normalizeClientPath(clientPath = '/') {
  const sanitized = String(clientPath).replace(/\\/g, '/').trim();
  const withLeadingSlash = sanitized.startsWith('/') ? sanitized : `/${sanitized}`;
  const normalized = path.posix.normalize(withLeadingSlash);
  return normalized === '.' ? '/' : normalized;
}

function resolveWithinRoot(clientPath = '/') {
  const relativePath = normalizeClientPath(clientPath).replace(/^\//, '');
  const fullPath = path.resolve(ROOT_DIR, relativePath);

  if (!fullPath.startsWith(ROOT_DIR)) {
    throw new Error('Path escapes ROOT_DIR');
  }

  return fullPath;
}

async function buildTree(clientPath = '/') {
  const fullPath = resolveWithinRoot(clientPath);
  const stats = await fsp.stat(fullPath);
  const name = clientPath === '/' ? 'root' : path.basename(fullPath);

  if (!stats.isDirectory()) {
    return {
      type: 'file',
      name,
      path: normalizeClientPath(clientPath),
      size: stats.size,
      modifiedAt: stats.mtimeMs,
    };
  }

  const entries = await fsp.readdir(fullPath, { withFileTypes: true });
  entries.sort((a, b) => {
    if (a.isDirectory() !== b.isDirectory()) {
      return a.isDirectory() ? -1 : 1;
    }
    return a.name.localeCompare(b.name);
  });

  const children = await Promise.all(
    entries.map(async (entry) => {
      const childClientPath = path.posix.join(normalizeClientPath(clientPath), entry.name);
      if (entry.isDirectory()) {
        return buildTree(childClientPath);
      }

      const childStats = await fsp.stat(resolveWithinRoot(childClientPath));
      return {
        type: 'file',
        name: entry.name,
        path: normalizeClientPath(childClientPath),
        size: childStats.size,
        modifiedAt: childStats.mtimeMs,
      };
    })
  );

  return {
    type: 'directory',
    name,
    path: normalizeClientPath(clientPath),
    children,
  };
}

async function ensureParentExists(fullPath) {
  const parent = path.dirname(fullPath);
  await fsp.mkdir(parent, { recursive: true });
}

app.get('/api/tree', async (req, res) => {
  try {
    const tree = await buildTree('/');
    res.json(tree);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/upload', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    const targetDir = normalizeClientPath(req.body.targetDir || '/');
    const targetDirPath = resolveWithinRoot(targetDir);
    await fsp.mkdir(targetDirPath, { recursive: true });

    const targetPath = path.join(targetDirPath, req.file.originalname);
    await fsp.writeFile(targetPath, req.file.buffer);

    return res.json({ ok: true });
  } catch (error) {
    return res.status(400).json({ error: error.message });
  }
});

app.post('/api/create-folder', async (req, res) => {
  try {
    const { parentDir = '/', folderName } = req.body;
    if (!folderName || /[\\/]/.test(folderName)) {
      return res.status(400).json({ error: 'Invalid folder name' });
    }

    const targetPath = resolveWithinRoot(path.posix.join(normalizeClientPath(parentDir), folderName));
    await fsp.mkdir(targetPath, { recursive: false });
    res.json({ ok: true });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.post('/api/delete', async (req, res) => {
  try {
    const { targetPath } = req.body;
    const fullPath = resolveWithinRoot(targetPath);
    await fsp.rm(fullPath, { recursive: true, force: false });
    res.json({ ok: true });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.post('/api/rename', async (req, res) => {
  try {
    const { targetPath, newName } = req.body;
    if (!newName || /[\\/]/.test(newName)) {
      return res.status(400).json({ error: 'Invalid new name' });
    }

    const sourcePath = resolveWithinRoot(targetPath);
    const destinationPath = path.join(path.dirname(sourcePath), newName);

    if (!destinationPath.startsWith(ROOT_DIR)) {
      return res.status(400).json({ error: 'Invalid destination' });
    }

    await fsp.rename(sourcePath, destinationPath);
    res.json({ ok: true });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.post('/api/move', async (req, res) => {
  try {
    const { sourcePath, destinationDir } = req.body;
    const sourceFullPath = resolveWithinRoot(sourcePath);
    const destinationDirFullPath = resolveWithinRoot(destinationDir);
    await fsp.mkdir(destinationDirFullPath, { recursive: true });

    const targetPath = path.join(destinationDirFullPath, path.basename(sourceFullPath));
    await fsp.rename(sourceFullPath, targetPath);

    res.json({ ok: true });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.get('/api/download', async (req, res) => {
  try {
    const clientPath = req.query.path;
    const fullPath = resolveWithinRoot(clientPath);
    const stats = await fsp.stat(fullPath);

    if (stats.isDirectory()) {
      return res.status(400).json({ error: 'Cannot download a directory' });
    }

    const filename = path.basename(fullPath);
    res.setHeader('Content-Type', mime.lookup(filename) || 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    fs.createReadStream(fullPath).pipe(res);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

async function collectFilesRecursively(dirPath) {
  const dirents = await fsp.readdir(dirPath, { withFileTypes: true });
  const files = [];

  for (const dirent of dirents) {
    const fullPath = path.join(dirPath, dirent.name);
    if (dirent.isDirectory()) {
      files.push(...(await collectFilesRecursively(fullPath)));
    } else if (dirent.isFile()) {
      files.push(fullPath);
    }
  }

  return files;
}

app.post('/api/process-logs', async (req, res) => {
  try {
    const {
      inputDir = '/logs',
      outputFile = '/result.txt',
      filterRegex = '',
      filterMode = 'positive',
      extractors = [],
      template = '',
    } = req.body;

    if (!Array.isArray(extractors) || !template) {
      return res.status(400).json({ error: 'Invalid payload' });
    }

    const inputDirFullPath = resolveWithinRoot(inputDir);
    const outputFileFullPath = resolveWithinRoot(outputFile);

    const filter = filterRegex ? new RegExp(filterRegex) : null;
    const extractorRegexes = extractors.map((item) => {
      if (!item.name || !item.regex) {
        throw new Error('Extractor name and regex are required');
      }
      const compiled = new RegExp(item.regex);
      return { ...item, compiled };
    });

    const files = await collectFilesRecursively(inputDirFullPath);
    const linesOut = [];

    for (const filePath of files) {
      const content = await fsp.readFile(filePath, 'utf8');
      const lines = content.split(/\r?\n/);

      for (const line of lines) {
        if (!line) continue;

        if (filter) {
          const matched = filter.test(line);
          if (filterMode === 'positive' && !matched) continue;
          if (filterMode === 'negative' && matched) continue;
        }

        const values = {};
        let skip = false;

        for (const extractor of extractorRegexes) {
          const m = line.match(extractor.compiled);
          if (!m || m.length < 2) {
            skip = true;
            break;
          }
          values[extractor.name] = m[1];
        }

        if (skip) continue;

        const outLine = template.replace(/\{([a-zA-Z0-9_]+)\}/g, (_, key) => values[key] ?? '');
        linesOut.push(outLine);
      }
    }

    await ensureParentExists(outputFileFullPath);
    await fsp.writeFile(outputFileFullPath, linesOut.join('\n'), 'utf8');

    res.json({ ok: true, outputFile: normalizeClientPath(outputFile), linesWritten: linesOut.length });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.listen(PORT, () => {
  console.log(`Server started at http://0.0.0.0:${PORT}`);
  console.log(`ROOT_DIR: ${ROOT_DIR}`);
});
