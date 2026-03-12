const state = {
  selectedPath: '/',
  filterEditor: null,
  templateEditor: null,
  ruleEditors: new Map(),
};

const el = {
  tree: $('#tree'),
  sourceDir: document.getElementById('sourceDir'),
  outputFile: document.getElementById('outputFile'),
  filterMode: document.getElementById('filterMode'),
  template: document.getElementById('template'),
  addRule: document.getElementById('addRule'),
  rules: document.getElementById('rules'),
  status: document.getElementById('status'),
  filterRegex: document.getElementById('filterRegex'),
};

CodeMirror.defineSimpleMode('templateMode', {
  start: [
    { regex: /\{[_a-zA-Z][_a-zA-Z0-9]*\}/, token: 'keyword' },
    { regex: /./, token: null },
  ],
});

function setStatus(obj) {
  el.status.textContent = typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2);
}

async function api(url, options = {}) {
  const response = await fetch(url, {
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    ...options,
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'Request failed');
  return data;
}

function initEditors() {
  state.filterEditor = CodeMirror.fromTextArea(el.filterRegex, {
    mode: 'javascript',
    lineNumbers: false,
  });

  state.templateEditor = CodeMirror.fromTextArea(el.template, {
    mode: 'templateMode',
    lineNumbers: false,
  });
}

function saveRuleHistory(name, regex) {
  if (!name || !regex) return;
  const key = `regexHistory:${name}`;
  const old = JSON.parse(localStorage.getItem(key) || '[]');
  const merged = [regex, ...old.filter((x) => x !== regex)].slice(0, 20);
  localStorage.setItem(key, JSON.stringify(merged));
}

function getRuleHistory(name) {
  return JSON.parse(localStorage.getItem(`regexHistory:${name}`) || '[]');
}

function addRule(name = '', regex = '') {
  const id = crypto.randomUUID();
  const card = document.createElement('div');
  card.className = 'rule-card';
  card.dataset.id = id;
  card.innerHTML = `
    <div class="row">
      <input placeholder="Имя поля, например ip" class="rule-name" value="${name}" />
      <button class="remove-rule">Удалить</button>
    </div>
    <datalist id="hist-${id}"></datalist>
    <textarea class="rule-regex"></textarea>
  `;
  el.rules.appendChild(card);

  const nameInput = card.querySelector('.rule-name');
  const textArea = card.querySelector('.rule-regex');
  textArea.value = regex;

  const editor = CodeMirror.fromTextArea(textArea, {
    mode: 'javascript',
    lineNumbers: false,
  });

  const list = card.querySelector(`#hist-${id}`);
  nameInput.addEventListener('input', () => {
    const history = getRuleHistory(nameInput.value.trim());
    list.innerHTML = history.map((h) => `<option value="${h.replace(/"/g, '&quot;')}"></option>`).join('');
  });

  card.querySelector('.remove-rule').addEventListener('click', () => {
    editor.toTextArea();
    state.ruleEditors.delete(id);
    card.remove();
  });

  state.ruleEditors.set(id, { editor, card });
}

function collectRules() {
  const rules = [];
  for (const { editor, card } of state.ruleEditors.values()) {
    const name = card.querySelector('.rule-name').value.trim();
    const regex = editor.getValue().trim();
    if (!name && !regex) continue;
    saveRuleHistory(name, regex);
    rules.push({ name, regex });
  }
  return rules;
}

async function loadTree() {
  const { children } = await api('/api/tree');

  el.tree.jstree('destroy');
  el.tree
    .jstree({
      core: {
        data: children,
        check_callback: true,
      },
      types: {
        file: { icon: 'jstree-file' },
        directory: { icon: 'jstree-folder' },
      },
      plugins: ['dnd', 'types'],
    })
    .on('select_node.jstree', (_e, data) => {
      state.selectedPath = data.node.id;
    })
    .on('move_node.jstree', async (_e, data) => {
      try {
        const parentId = data.parent === '#' ? '/' : data.parent;
        await api('/api/move', {
          method: 'POST',
          body: JSON.stringify({ from: data.node.id, toDir: parentId }),
        });
        setStatus('Элемент перемещён');
        await loadTree();
      } catch (error) {
        setStatus(error.message);
        await loadTree();
      }
    });
}

function selectedDirectoryPath() {
  const node = el.tree.jstree(true).get_node(state.selectedPath);
  if (!node) return '/';
  return node.type === 'directory' ? node.id : node.parent;
}

async function fileToBase64(file) {
  const buffer = await file.arrayBuffer();
  let binary = '';
  const bytes = new Uint8Array(buffer);
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

async function uploadFiles() {
  const files = Array.from(document.getElementById('uploadInput').files);
  if (!files.length) return;
  const payloadFiles = await Promise.all(files.map(async (file) => ({
    name: file.name,
    contentBase64: await fileToBase64(file),
  })));
  const data = await api('/api/upload', {
    method: 'POST',
    body: JSON.stringify({ targetDir: selectedDirectoryPath() || '/', files: payloadFiles }),
  });
  setStatus(data);
  await loadTree();
}

async function boot() {
  initEditors();
  addRule('ip', '(\\d+\\.\\d+\\.\\d+\\.\\d+)');
  addRule('site', 'host=([^\\s]+)');
  await loadTree();

  document.getElementById('refreshTree').onclick = () => loadTree();

  document.getElementById('createFolder').onclick = async () => {
    const name = prompt('Имя папки');
    if (!name) return;
    const parentDir = selectedDirectoryPath();
    try {
      await api('/api/folder', { method: 'POST', body: JSON.stringify({ parentDir, name }) });
      await loadTree();
    } catch (error) {
      setStatus(error.message);
    }
  };

  document.getElementById('renameItem').onclick = async () => {
    if (!state.selectedPath || state.selectedPath === '/') return;
    const name = prompt('Новое имя');
    if (!name) return;
    try {
      await api('/api/rename', { method: 'PATCH', body: JSON.stringify({ from: state.selectedPath, toName: name }) });
      await loadTree();
    } catch (error) {
      setStatus(error.message);
    }
  };

  document.getElementById('deleteItem').onclick = async () => {
    if (!state.selectedPath || state.selectedPath === '/') return;
    if (!confirm(`Удалить ${state.selectedPath}?`)) return;
    try {
      await api(`/api/item?path=${encodeURIComponent(state.selectedPath)}`, { method: 'DELETE' });
      state.selectedPath = '/';
      await loadTree();
    } catch (error) {
      setStatus(error.message);
    }
  };

  document.getElementById('downloadItem').onclick = () => {
    if (!state.selectedPath || state.selectedPath === '/') return;
    window.open(`/api/download?path=${encodeURIComponent(state.selectedPath)}`, '_blank');
  };

  document.getElementById('uploadBtn').onclick = () => uploadFiles().catch((e) => setStatus(e.message));
  el.addRule.onclick = () => addRule();

  document.getElementById('processBtn').onclick = async () => {
    try {
      const payload = {
        sourceDir: el.sourceDir.value.trim(),
        outputFile: el.outputFile.value.trim(),
        filterRegex: state.filterEditor.getValue().trim(),
        filterMode: el.filterMode.value,
        rules: collectRules(),
        template: state.templateEditor.getValue(),
      };
      const result = await api('/api/process', { method: 'POST', body: JSON.stringify(payload) });
      setStatus(result);
      await loadTree();
    } catch (error) {
      setStatus(error.message);
    }
  };
}

boot().catch((error) => setStatus(error.message));
