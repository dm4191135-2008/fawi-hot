'use strict';
const express = require('express');
const multer = require('multer');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const yauzl = require('yauzl');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { pipeline } = require('stream/promises');

const app = express();
const PORT = Number(process.env.PORT) || 3000;
const ROOT = __dirname;
const DATA_DIR = path.resolve(process.env.DATA_DIR || ROOT);
const SITES_DIR = path.join(DATA_DIR, 'sites');
const TEMP_DIR = path.join(DATA_DIR, 'temp');
const MAX_UPLOAD = 50 * 1024 * 1024;
const MAX_FILES = 500;
const ALLOWED = new Set(['.html','.htm','.css','.js','.mjs','.json','.txt','.xml','.webmanifest','.svg','.png','.jpg','.jpeg','.gif','.webp','.avif','.ico','.woff','.woff2','.ttf','.otf','.mp4','.webm','.mp3','.pdf']);
for (const dir of [SITES_DIR, TEMP_DIR]) fs.mkdirSync(dir, { recursive: true });

app.disable('x-powered-by');
app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));
app.use(express.json({ limit: '32kb' }));
app.use('/api/', rateLimit({ windowMs: 15 * 60 * 1000, limit: 80, standardHeaders: 'draft-7', legacyHeaders: false }));
app.use((req, res, next) => {
  if (/^\/(sites|temp)(\/|$)/.test(req.path) || /^\/(server\.js|package\.json|README\.md|\.gitignore)$/.test(req.path)) return res.sendStatus(404);
  next();
});
app.use(express.static(ROOT, { index: 'index.html', dotfiles: 'deny' }));

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, TEMP_DIR),
  filename: (_req, file, cb) => cb(null, crypto.randomUUID() + path.extname(file.originalname).toLowerCase())
});
const upload = multer({
  preservePath: true,
  storage, limits: { fileSize: MAX_UPLOAD, files: MAX_FILES, fields: 2, fieldSize: 200 },
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (!ALLOWED.has(ext) && ext !== '.zip') return cb(new Error(`Tipo de ficheiro não permitido: ${ext || 'sem extensão'}`));
    cb(null, true);
  }
});

function cleanName(value) {
  const s = String(value || 'meu-projeto').normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48);
  return s || 'meu-projeto';
}
function safeJoin(root, rel) {
  const normalized = rel.replace(/\\/g, '/');
  if (!normalized || normalized.startsWith('/') || /^[a-zA-Z]:/.test(normalized) ||
      normalized.split('/').some(p => p === '..' || p === '.' || p === '')) throw new Error('Caminho inválido no pacote.');
  const out = path.resolve(root, ...normalized.split('/'));
  if (!out.startsWith(path.resolve(root) + path.sep)) throw new Error('Caminho fora da pasta permitida.');
  return out;
}
function allowedFile(rel) {
  const ext = path.extname(rel).toLowerCase();
  if (!ALLOWED.has(ext)) throw new Error(`Extensão não permitida: ${ext || 'sem extensão'}`);
}
async function copyUploaded(file, destRoot, rel) {
  allowedFile(rel);
  const dest = safeJoin(destRoot, rel);
  await fs.promises.mkdir(path.dirname(dest), { recursive: true });
  await fs.promises.copyFile(file.path, dest, fs.constants.COPYFILE_EXCL);
}
function extractZip(zipPath, destRoot) {
  return new Promise((resolve, reject) => {
    yauzl.open(zipPath, { lazyEntries: true, decodeStrings: true, validateEntrySizes: true }, (err, zip) => {
      if (err) return reject(err);
      let count = 0, total = 0, finished = false;
      const fail = e => { if (!finished) { finished = true; zip.close(); reject(e); } };
      zip.on('error', fail);
      zip.on('end', () => { if (!finished) { finished = true; resolve({ count, total }); } });
      zip.on('entry', entry => {
        try {
          if (++count > MAX_FILES) throw new Error('O ZIP contém demasiados ficheiros.');
          const name = entry.fileName.replace(/\\/g, '/');
          if (name.endsWith('/')) { safeJoin(destRoot, name.slice(0, -1) || 'folder'); zip.readEntry(); return; }
          allowedFile(name);
          const dest = safeJoin(destRoot, name);
          total += entry.uncompressedSize || 0;
          if (total > MAX_UPLOAD) throw new Error('O conteúdo extraído ultrapassa 50 MB.');
          fs.promises.mkdir(path.dirname(dest), { recursive: true }).then(() => {
            zip.openReadStream(entry, (streamErr, stream) => {
              if (streamErr) return fail(streamErr);
              const out = fs.createWriteStream(dest, { flags: 'wx' });
              pipeline(stream, out).then(() => zip.readEntry()).catch(fail);
            });
          }).catch(fail);
        } catch (e) { fail(e); }
      });
      zip.readEntry();
    });
  });
}
async function removeFiles(files) {
  await Promise.all((files || []).map(f => fs.promises.rm(f.path, { force: true }).catch(() => {})));
}
async function findUniqueId(slug) {
  for (let i = 0; i < 5; i++) {
    const id = `${slug}-${crypto.randomBytes(3).toString('hex')}`;
    try { await fs.promises.access(path.join(SITES_DIR, id)); } catch { return id; }
  }
  return `${slug}-${crypto.randomUUID().slice(0,8)}`;
}
function metadata(id) {
  try { return JSON.parse(fs.readFileSync(path.join(SITES_DIR, id, 'site.json'), 'utf8')); } catch { return null; }
}

app.post('/api/publish', upload.array('files', MAX_FILES), async (req, res) => {
  const files = req.files || [];
  let workDir;
  try {
    if (!files.length) return res.status(400).json({ error: 'Seleciona os ficheiros do site ou um ZIP.' });
    const totalUploadSize = files.reduce((sum, file) => sum + (file.size || 0), 0);
    if (totalUploadSize > MAX_UPLOAD) throw new Error('O envio ultrapassa o limite total de 50 MB.');
    const projectName = cleanName(req.body.projectName);
    workDir = await fs.promises.mkdtemp(path.join(TEMP_DIR, 'publish-'));
    const zipFiles = files.filter(f => path.extname(f.originalname).toLowerCase() === '.zip');
    if (zipFiles.length) {
      if (files.length !== 1) throw new Error('Envia um ZIP de cada vez, sem misturar com outros ficheiros.');
      await extractZip(zipFiles[0].path, workDir);
    } else {
      for (const file of files) {
        const rel = file.originalname.replace(/\\/g, '/').replace(/^\/+/, '');
        await copyUploaded(file, workDir, rel);
      }
    }
    let indexPath = path.join(workDir, 'index.html');
    if (!fs.existsSync(indexPath)) {
      const dirs = await fs.promises.readdir(workDir, { withFileTypes: true });
      const nested = dirs.filter(d => d.isDirectory());
      if (nested.length === 1 && fs.existsSync(path.join(workDir, nested[0].name, 'index.html'))) {
        const nestedDir = path.join(workDir, nested[0].name);
        const entries = await fs.promises.readdir(nestedDir);
        for (const entry of entries) await fs.promises.rename(path.join(nestedDir, entry), path.join(workDir, entry));
        await fs.promises.rmdir(nestedDir);
        indexPath = path.join(workDir, 'index.html');
      }
    }
    if (!fs.existsSync(indexPath)) throw new Error('Não foi encontrado um index.html na raiz do site.');
    const id = await findUniqueId(projectName);
    const finalDir = path.join(SITES_DIR, id);
    await fs.promises.rename(workDir, finalDir);
    workDir = null;
    const info = { id, name: projectName, createdAt: new Date().toISOString(), files: countFiles(finalDir) };
    await fs.promises.writeFile(path.join(finalDir, 'site.json'), JSON.stringify(info, null, 2));
    res.status(201).json({ success: true, site: info, url: `/s/${id}/` });
  } catch (err) {
    res.status(400).json({ error: err.message || 'Não foi possível publicar o site.' });
  } finally {
    await removeFiles(files);
    if (workDir) await fs.promises.rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
});
function countFiles(dir) {
  let n = 0;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'site.json') continue;
    n += e.isDirectory() ? countFiles(path.join(dir, e.name)) : 1;
  }
  return n;
}
app.get('/health', (_req, res) => res.json({ status: 'ok' }));
app.get('/api/sites', (_req, res) => {
  const sites = [];
  for (const entry of fs.readdirSync(SITES_DIR, { withFileTypes: true })) {
    if (entry.isDirectory()) { const data = metadata(entry.name); if (data) sites.push(data); }
  }
  sites.sort((a,b) => b.createdAt.localeCompare(a.createdAt));
  res.json({ sites });
});
app.delete('/api/sites/:id', async (req, res) => {
  const id = req.params.id;
  if (!/^[a-z0-9-]{1,64}$/.test(id)) return res.status(400).json({ error: 'Identificador inválido.' });
  const target = path.resolve(SITES_DIR, id);
  if (!target.startsWith(path.resolve(SITES_DIR) + path.sep)) return res.status(400).json({ error: 'Caminho inválido.' });
  try { await fs.promises.rm(target, { recursive: true, force: true }); res.json({ success: true }); }
  catch { res.status(500).json({ error: 'Não foi possível apagar o projeto.' }); }
});
app.get('/s/:id/*', (req, res, next) => {
  const id = req.params.id;
  if (!/^[a-z0-9-]{1,64}$/.test(id)) return res.sendStatus(404);
  const root = path.resolve(SITES_DIR, id);
  if (!root.startsWith(path.resolve(SITES_DIR) + path.sep) || !fs.existsSync(path.join(root, 'index.html'))) return res.sendStatus(404);
  // Uploaded pages run in a browser sandbox to isolate them from the FAWI HOST dashboard/API origin.
  res.setHeader('Content-Security-Policy', "sandbox allow-scripts allow-forms allow-popups; default-src 'self' data: blob: https: http:; img-src * data: blob:; style-src * 'unsafe-inline'; script-src * 'unsafe-inline' 'unsafe-eval'; connect-src *");
  const rel = req.params[0] || 'index.html';
  if (rel.split('/').some(part => part.toLowerCase() === 'site.json')) return res.sendStatus(404);
  let target;
  try { target = safeJoin(root, rel || 'index.html'); } catch { return res.sendStatus(404); }
  if (fs.existsSync(target) && fs.statSync(target).isDirectory()) target = path.join(target, 'index.html');
  if (!target.startsWith(root + path.sep) || !fs.existsSync(target) || !fs.statSync(target).isFile()) return res.sendStatus(404);
  res.sendFile(target, { dotfiles: 'deny' }, err => { if (err && !res.headersSent) next(err); });
});
app.get('/s/:id', (req, res) => res.redirect(301, `/s/${req.params.id}/`));
app.use((err, _req, res, _next) => {
  const status = err instanceof multer.MulterError || /^Tipo de ficheiro não permitido:/.test(err.message || '') || /LIMIT_/.test(err.code || '') ? 400 : 500;
  res.status(status).json({ error: err.message || 'Ocorreu um erro inesperado.' });
});
app.listen(PORT, () => console.log(`FAWI HOST a funcionar na porta ${PORT}; DATA_DIR=${DATA_DIR}`));
