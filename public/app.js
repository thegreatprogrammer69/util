const HISTORY_KEY = 'regex-history-v1';

const state = {
  treeData: null,
  filterEditor: null,
  templateEditor: null,
  extractorRows: [],
};

function showResult(message, isError = false) {
  const box = document.getElementById('resultBox');
  box.style.color = isError ? '#fca5a5' : '#93c5fd';
  box.textContent = message;
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    ...options,
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.error || `HTTP ${response.status}`);
  }
  return data;
}

function toJsTreeNode(node) {
  const isDir = node.type === 'directory';
  return {
    id: node.path,
    text: node.name,
    icon: isDir ? 'jstree-folder' : 'jstree-file',
    data: node,
    children: isDir ? (node.children || []).map(toJsTreeNode) : false,
  };
}

async function refreshTree() {
  const tree = await api('/api/tree');
  state.treeData = tree;
  const treeData = [toJsTreeNode(tree)];

  const $tree = $('#fileTree');
  $tree.jstree('destroy');
  $tree.jstree({
    core: {
      data: treeData,
      check_callback: true,
      multiple: false,
    },
    plugins: ['dnd', 'contextmenu'],
    contextmenu: {
      items: (node) => {
        const isDir = node.data.type === 'directory';
        return {
          createFolder: {
            label: 'Создать папку',
            action: async () => {
              const folderName = prompt('Имя папки:');
              if (!folderName) return;
              await api('/api/create-folder', {
                method: 'POST',
                body: JSON.stringify({
                  parentDir: isDir ? node.id : node.parent,
                  folderName,
                }),
              });
              await refreshTree();
            },
          },
          rename: {
            label: 'Переименовать',
            action: async () => {
              const newName = prompt('Новое имя:', node.text);
              if (!newName) return;
              await api('/api/rename', {
                method: 'POST',
                body: JSON.stringify({ targetPath: node.id, newName }),
              });
              await refreshTree();
            },
          },
          delete: {
            label: 'Удалить',
            action: async () => {
              if (!confirm(`Удалить ${node.text}?`)) return;
              await api('/api/delete', {
                method: 'POST',
                body: JSON.stringify({ targetPath: node.id }),
              });
              await refreshTree();
            },
          },
          download: {
            label: 'Скачать',
            _disabled: isDir,
            action: () => {
              window.open(`/api/download?path=${encodeURIComponent(node.id)}`, '_blank');
            },
          },
        };
      },
    },
  });

  $tree.off('move_node.jstree').on('move_node.jstree', async (_event, data) => {
    try {
      await api('/api/move', {
        method: 'POST',
        body: JSON.stringify({
          sourcePath: data.node.id,
          destinationDir: data.parent,
        }),
      });
      await refreshTree();
    } catch (error) {
      showResult(error.message, true);
      await refreshTree();
    }
  });
}

function addRegexHistory(value) {
  if (!value.trim()) return;
  const existing = JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]');
  const merged = [value, ...existing.filter((item) => item !== value)].slice(0, 30);
  localStorage.setItem(HISTORY_KEY, JSON.stringify(merged));
}

function getRegexHistory() {
  return JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]');
}

function registerTemplateHighlight() {
  CodeMirror.defineMode('templateMode', (config, parserConfig) => {
    const jsMode = CodeMirror.getMode(config, parserConfig.backdrop || 'text/plain');
    return CodeMirror.overlayMode(jsMode, {
      token(stream) {
        if (stream.match(/\{[a-zA-Z0-9_]+\}/)) {
          return 'placeholder';
        }
        while (stream.next() != null && !stream.match(/\{[a-zA-Z0-9_]+\}/, false)) {}
        return null;
      },
    });
  });
}

function createRegexEditor(textarea, initialValue = '') {
  const editor = CodeMirror.fromTextArea(textarea, {
    mode: 'javascript',
    theme: 'material-darker',
    lineNumbers: false,
  });
  editor.setValue(initialValue);
  return editor;
}

function createExtractorRow(name = '', regex = '') {
  const container = document.createElement('div');
  container.className = 'extractor-row';

  const top = document.createElement('div');
  top.className = 'extractor-top';

  const nameInput = document.createElement('input');
  nameInput.placeholder = 'name, напр. ip';
  nameInput.value = name;

  const historyListId = `regexHistory-${Math.random().toString(36).slice(2)}`;
  const regexInput = document.createElement('input');
  regexInput.placeholder = 'regex c 1 группой';
  regexInput.setAttribute('list', historyListId);
  regexInput.value = regex;

  const datalist = document.createElement('datalist');
  datalist.id = historyListId;
  getRegexHistory().forEach((item) => {
    const option = document.createElement('option');
    option.value = item;
    datalist.appendChild(option);
  });

  const removeBtn = document.createElement('button');
  removeBtn.className = 'remove-extractor';
  removeBtn.textContent = 'Удалить';

  top.appendChild(nameInput);
  top.appendChild(regexInput);
  top.appendChild(removeBtn);

  const cmArea = document.createElement('textarea');
  container.appendChild(top);
  container.appendChild(datalist);
  container.appendChild(cmArea);

  const cmEditor = createRegexEditor(cmArea, regex);
  cmEditor.on('change', () => {
    regexInput.value = cmEditor.getValue();
  });

  regexInput.addEventListener('change', () => {
    cmEditor.setValue(regexInput.value);
    addRegexHistory(regexInput.value);
  });

  removeBtn.addEventListener('click', () => {
    container.remove();
    state.extractorRows = state.extractorRows.filter((row) => row.container !== container);
  });

  const row = {
    container,
    nameInput,
    regexInput,
    cmEditor,
  };
  state.extractorRows.push(row);
  document.getElementById('extractors').appendChild(container);
}

async function uploadFile() {
  const fileInput = document.getElementById('uploadFile');
  const targetDir = document.getElementById('uploadTarget').value || '/';

  if (!fileInput.files[0]) {
    showResult('Выберите файл для загрузки', true);
    return;
  }

  const formData = new FormData();
  formData.append('file', fileInput.files[0]);
  formData.append('targetDir', targetDir);

  const response = await fetch('/api/upload', { method: 'POST', body: formData });
  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.error || 'Upload failed');
  }

  fileInput.value = '';
}

function getExtractorsPayload() {
  return state.extractorRows
    .map((row) => ({
      name: row.nameInput.value.trim(),
      regex: row.cmEditor.getValue().trim(),
    }))
    .filter((row) => row.name && row.regex);
}

async function processLogs() {
  const filterMode = document.querySelector('input[name="filterMode"]:checked').value;
  const payload = {
    inputDir: document.getElementById('inputDir').value.trim(),
    outputFile: document.getElementById('outputFile').value.trim(),
    filterRegex: state.filterEditor.getValue().trim(),
    filterMode,
    extractors: getExtractorsPayload(),
    template: state.templateEditor.getValue(),
  };

  const data = await api('/api/process-logs', {
    method: 'POST',
    body: JSON.stringify(payload),
  });

  payload.extractors.forEach((item) => addRegexHistory(item.regex));
  showResult(`Готово. Строк записано: ${data.linesWritten}. Файл: ${data.outputFile}`);
}

async function init() {
  registerTemplateHighlight();

  state.filterEditor = createRegexEditor(document.getElementById('filterRegex'));
  state.templateEditor = CodeMirror.fromTextArea(document.getElementById('templateLine'), {
    mode: 'templateMode',
    theme: 'material-darker',
    lineNumbers: false,
  });

  addExtractorRow('ip', '(\\d+\\.\\d+\\.\\d+\\.\\d+)');

  document.getElementById('refreshTreeBtn').addEventListener('click', () => {
    refreshTree().catch((err) => showResult(err.message, true));
  });

  document.getElementById('uploadBtn').addEventListener('click', async () => {
    try {
      await uploadFile();
      await refreshTree();
      showResult('Файл успешно загружен');
    } catch (error) {
      showResult(error.message, true);
    }
  });

  document.getElementById('addExtractorBtn').addEventListener('click', () => createExtractorRow());

  document.getElementById('processBtn').addEventListener('click', async () => {
    try {
      await processLogs();
    } catch (error) {
      showResult(error.message, true);
    }
  });

  await refreshTree();
}

init().catch((error) => showResult(error.message, true));
