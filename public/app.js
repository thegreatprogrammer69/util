const statusEl = document.getElementById('status');
const patternsEl = document.getElementById('patterns');
const historyKey = 'regexHistory.v1';
const regexHistory = JSON.parse(localStorage.getItem(historyKey) || '[]');

const filterEditor = CodeMirror.fromTextArea(document.getElementById('filterRegex'), {
  mode: 'javascript',
  lineNumbers: false,
  theme: 'default'
});

const templateEditor = CodeMirror.fromTextArea(document.getElementById('outputTemplate'), {
  mode: 'javascript',
  lineNumbers: false,
  theme: 'default'
});

function setStatus(text, isError = false) {
  statusEl.textContent = text;
  statusEl.style.color = isError ? '#ffb4b4' : '#d8f0ff';
}

async function api(url, options = {}) {
  const response = await fetch(url, options);
  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.error || 'Request failed');
  }
  return data;
}

async function loadTree() {
  const treeData = await api('/api/tree');
  $('#tree').jstree('destroy');
  $('#tree').jstree({
    core: {
      data: [treeData],
      check_callback: true,
      themes: { dots: true }
    },
    plugins: ['dnd', 'contextmenu', 'types'],
    types: {
      folder: { icon: 'jstree-folder' },
      file: { icon: 'jstree-file' }
    },
    contextmenu: {
      items: (node) => {
        const items = {
          rename: {
            label: 'Переименовать',
            action: async () => {
              const newName = prompt('Новое имя', node.text);
              if (!newName) return;
              await api('/api/rename', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ path: node.id, newName })
              });
              await loadTree();
            }
          },
          delete: {
            label: 'Удалить',
            action: async () => {
              if (!confirm(`Удалить ${node.text}?`)) return;
              await api(`/api/delete?path=${encodeURIComponent(node.id)}`, { method: 'DELETE' });
              await loadTree();
            }
          }
        };

        if (node.type === 'folder') {
          items.createFolder = {
            label: 'Создать папку',
            action: async () => {
              const name = prompt('Имя папки');
              if (!name) return;
              await api('/api/create-folder', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ parent: node.id, name })
              });
              await loadTree();
            }
          };
        }

        if (node.type === 'file') {
          items.download = {
            label: 'Скачать',
            action: () => {
              window.location.href = `/api/download?path=${encodeURIComponent(node.id)}`;
            }
          };
        }

        return items;
      }
    }
  });

  $('#tree').on('move_node.jstree', async (e, data) => {
    try {
      await api('/api/move', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ source: data.node.id, destinationDir: data.parent })
      });
    } catch (err) {
      setStatus(err.message, true);
    }
    await loadTree();
  });
}

function createPatternRow(value = { key: '', regex: '' }) {
  const row = document.createElement('div');
  row.className = 'pattern-row';

  const keyInput = document.createElement('input');
  keyInput.type = 'text';
  keyInput.placeholder = 'key (например ip)';
  keyInput.value = value.key;

  const regexArea = document.createElement('textarea');
  regexArea.value = value.regex;

  const deleteBtn = document.createElement('button');
  deleteBtn.type = 'button';
  deleteBtn.textContent = 'Удалить';
  deleteBtn.onclick = () => row.remove();

  row.appendChild(keyInput);
  row.appendChild(regexArea);
  row.appendChild(deleteBtn);
  patternsEl.appendChild(row);

  const editor = CodeMirror.fromTextArea(regexArea, {
    mode: 'javascript',
    lineNumbers: false,
    theme: 'default'
  });

  const listId = `regex-history-${Math.random().toString(36).slice(2)}`;
  const datalist = document.createElement('datalist');
  datalist.id = listId;
  regexHistory.forEach((r) => {
    const option = document.createElement('option');
    option.value = r;
    datalist.appendChild(option);
  });
  document.body.appendChild(datalist);
  editor.getInputField().setAttribute('list', listId);

  row.getData = () => ({ key: keyInput.value.trim(), regex: editor.getValue().trim() });
}

document.getElementById('addPatternBtn').addEventListener('click', () => createPatternRow());

document.getElementById('uploadBtn').addEventListener('click', async () => {
  const input = document.getElementById('uploadInput');
  if (!input.files[0]) return;

  const tree = $('#tree').jstree(true);
  const selected = tree.get_selected(true)[0];
  const targetDir = selected && selected.type === 'folder' ? selected.id : '/';

  const formData = new FormData();
  formData.append('file', input.files[0]);
  formData.append('targetDir', targetDir);

  try {
    await api('/api/upload', { method: 'POST', body: formData });
    setStatus(`Файл загружен в ${targetDir}`);
    input.value = '';
    await loadTree();
  } catch (err) {
    setStatus(err.message, true);
  }
});

document.getElementById('processorForm').addEventListener('submit', async (e) => {
  e.preventDefault();

  const patterns = Array.from(document.querySelectorAll('.pattern-row')).map((row) => row.getData());
  const regexes = patterns.map((p) => p.regex).filter(Boolean);
  const updated = Array.from(new Set([...regexHistory, ...regexes])).slice(-100);
  localStorage.setItem(historyKey, JSON.stringify(updated));

  const payload = {
    inputDir: document.getElementById('inputDir').value.trim(),
    outputFile: document.getElementById('outputFile').value.trim(),
    filterRegex: filterEditor.getValue().trim(),
    filterMode: document.getElementById('filterMode').value,
    patterns,
    template: templateEditor.getValue()
  };

  try {
    const result = await api('/api/process', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    setStatus(`Готово. Создано строк: ${result.lines}`);
    await loadTree();
  } catch (err) {
    setStatus(err.message, true);
  }
});

createPatternRow({ key: 'ip', regex: '(\\d+\\.\\d+\\.\\d+\\.\\d+)' });
createPatternRow({ key: 'site', regex: 'https?:\\/\\/([^\\s\\/]+)' });
loadTree().catch((err) => setStatus(err.message, true));
