const treeEl = document.querySelector('#tree');
const targetDirInput = document.querySelector('#targetDirInput');
const uploadInput = document.querySelector('#uploadInput');
const uploadBtn = document.querySelector('#uploadBtn');
const newFolderBtn = document.querySelector('#newFolderBtn');
const mappingRows = document.querySelector('#mappingRows');
const rowTemplate = document.querySelector('#mappingRowTemplate');
const addMappingBtn = document.querySelector('#addMappingBtn');
const runBtn = document.querySelector('#runBtn');
const resultEl = document.querySelector('#result');
const templateInput = document.querySelector('#template');
const templatePreview = document.querySelector('#templatePreview');
const regexHistoryList = document.querySelector('#regexHistory');

const includeRegexInput = document.querySelector('#includeRegex');
const includeRegexPreview = document.querySelector('#includeRegexPreview');

const regexHistoryKey = 'regexHistory';
let regexHistory = JSON.parse(localStorage.getItem(regexHistoryKey) || '[]');

const saveRegexHistory = (value) => {
  const v = value?.trim();
  if (!v) return;
  regexHistory = [v, ...regexHistory.filter((x) => x !== v)].slice(0, 30);
  localStorage.setItem(regexHistoryKey, JSON.stringify(regexHistory));
  renderRegexHistory();
};

const renderRegexHistory = () => {
  regexHistoryList.innerHTML = '';
  for (const item of regexHistory) {
    const option = document.createElement('option');
    option.value = item;
    regexHistoryList.appendChild(option);
  }
};

const escHtml = (s) => s
  .replaceAll('&', '&amp;')
  .replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;');


const highlightRegex = (value = '') => {
  const escaped = escHtml(value);
  return escaped
    .replace(/(\\.|\[\^?[^\]]*\]|\(\?:|\(|\)|\+|\*|\?|\||\{|\}|\^|\$)/g, '<span class="syntax-highlight">$1</span>');
};

const updateIncludePreview = () => {
  includeRegexPreview.innerHTML = `Regex: ${highlightRegex(includeRegexInput.value)}`;
};

const updateTemplatePreview = () => {
  const html = escHtml(templateInput.value).replace(/\{([a-zA-Z0-9_]+)\}/g, '<span class="placeholder-highlight">{$1}</span>');
  templatePreview.innerHTML = `Preview: ${html}`;
};

const api = async (url, options = {}) => {
  const res = await fetch(url, options);
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'API error');
  return data;
};

const renderTreeNode = (node, container) => {
  const wrapper = document.createElement('div');
  wrapper.className = 'tree-node';

  const row = document.createElement('div');
  row.className = 'tree-row';
  const name = document.createElement('span');
  name.className = `name ${node.type === 'directory' ? 'dir' : 'file'}`;
  name.textContent = `${node.type === 'directory' ? '📁' : '📄'} ${node.name}`;
  row.appendChild(name);

  const selectBtn = document.createElement('button');
  selectBtn.textContent = 'Выбрать';
  selectBtn.onclick = () => { targetDirInput.value = node.type === 'directory' ? node.path : node.path.replace(/\/[^/]+$/, '') || '/'; };
  row.appendChild(selectBtn);

  const renameBtn = document.createElement('button');
  renameBtn.textContent = 'Переим.';
  renameBtn.onclick = async () => {
    const newName = prompt('Новое имя:', node.name);
    if (!newName) return;
    await api('/api/rename', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: node.path, newName })
    });
    loadTree();
  };
  row.appendChild(renameBtn);

  const moveBtn = document.createElement('button');
  moveBtn.textContent = 'Переместить';
  moveBtn.onclick = async () => {
    const destDir = prompt('Куда переместить? (директория, например /logs)', '/');
    if (!destDir) return;
    await api('/api/move', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ srcPath: node.path, destDir })
    });
    loadTree();
  };
  row.appendChild(moveBtn);

  if (node.type === 'file') {
    const dl = document.createElement('a');
    dl.href = `/api/download?path=${encodeURIComponent(node.path)}`;
    dl.textContent = 'Скачать';
    dl.className = 'btn';
    row.appendChild(dl);
  }

  const delBtn = document.createElement('button');
  delBtn.textContent = 'Удалить';
  delBtn.onclick = async () => {
    if (!confirm(`Удалить ${node.path}?`)) return;
    await api('/api/delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: node.path })
    });
    loadTree();
  };
  row.appendChild(delBtn);

  wrapper.appendChild(row);

  if (node.children?.length) {
    node.children.forEach((child) => renderTreeNode(child, wrapper));
  }

  container.appendChild(wrapper);
};

const loadTree = async () => {
  const data = await api('/api/tree');
  treeEl.innerHTML = '';
  data.children.forEach((node) => renderTreeNode(node, treeEl));
};

const addMappingRow = (key = '', regex = '') => {
  const row = rowTemplate.content.firstElementChild.cloneNode(true);
  row.querySelector('.map-key').value = key;
  row.querySelector('.map-regex').value = regex;
  const regexInput = row.querySelector('.map-regex');
  const preview = document.createElement('small');
  preview.innerHTML = `Regex: ${highlightRegex(regexInput.value)}`;
  row.appendChild(preview);
  regexInput.addEventListener('input', () => { preview.innerHTML = `Regex: ${highlightRegex(regexInput.value)}`; });
  regexInput.addEventListener('change', (e) => saveRegexHistory(e.target.value));
  row.querySelector('.remove-row').addEventListener('click', () => row.remove());
  mappingRows.appendChild(row);
};

uploadBtn.addEventListener('click', async () => {
  const files = uploadInput.files;
  if (!files.length) return;

  const form = new FormData();
  form.append('targetDir', targetDirInput.value || '/');
  for (const file of files) {
    form.append('files', file);
  }
  await api('/api/upload', { method: 'POST', body: form });
  uploadInput.value = '';
  loadTree();
});

newFolderBtn.addEventListener('click', async () => {
  const name = prompt('Название папки:');
  if (!name) return;
  await api('/api/folder', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ dirPath: targetDirInput.value || '/', name })
  });
  loadTree();
});

addMappingBtn.addEventListener('click', () => addMappingRow());

templateInput.addEventListener('input', updateTemplatePreview);

includeRegexInput.addEventListener('input', updateIncludePreview);
includeRegexInput.addEventListener('change', (e) => saveRegexHistory(e.target.value));

runBtn.addEventListener('click', async () => {
  try {
    const mappings = [...mappingRows.querySelectorAll('.mapping-row')].map((row) => ({
      key: row.querySelector('.map-key').value.trim(),
      regex: row.querySelector('.map-regex').value.trim()
    })).filter((x) => x.key && x.regex);

    mappings.forEach((m) => saveRegexHistory(m.regex));

    const payload = {
      inputDir: document.querySelector('#inputDir').value,
      outputFile: document.querySelector('#outputFile').value,
      includeRegex: document.querySelector('#includeRegex').value,
      includeMode: document.querySelector('#includeMode').value,
      mappings,
      template: templateInput.value
    };

    const result = await api('/api/process', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    resultEl.textContent = JSON.stringify(result, null, 2);
    loadTree();
  } catch (error) {
    resultEl.textContent = `Ошибка: ${error.message}`;
  }
});

renderRegexHistory();
addMappingRow('ip', '(\\d+\\.\\d+\\.\\d+\\.\\d+)');
addMappingRow('site', 'site=([^\\s]+)');
updateIncludePreview();
updateTemplatePreview();
loadTree();
