# File + Regex Web Tool

Node.js веб-приложение для управления файлами в `./root` и обработки логов регулярными выражениями.

## Возможности

- Дерево файлов в `./root`: загрузка, удаление, переименование, перемещение, создание папок, скачивание файлов.
- Панель обработки:
  - выбор входной директории (`/logs` => `./root/logs`),
  - выбор выходного файла (`/result.txt` => `./root/result.txt`),
  - позитивный/негативный фильтр по regex,
  - несколько regex-правил (`ключ -> regex с одной группой`),
  - история regex с подсказками,
  - шаблон результата с подстановками `{key}`.

## Быстрый старт

### Локально

```bash
npm install
npm start
```

Открыть: http://localhost:3000

### Docker Compose

```bash
docker compose up --build
```

`./root` на хосте примонтирован в контейнер как `/data/root`.

## API (кратко)

- `GET /api/tree`
- `POST /api/upload` (`multipart/form-data`: `targetDir`, `files[]`)
- `POST /api/folder` `{ dirPath, name }`
- `POST /api/rename` `{ path, newName }`
- `POST /api/move` `{ srcPath, destDir }`
- `POST /api/delete` `{ path }`
- `GET /api/download?path=/...`
- `POST /api/process` `{ inputDir, outputFile, includeRegex, includeMode, mappings, template }`
