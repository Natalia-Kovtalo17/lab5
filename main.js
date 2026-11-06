const http = require('http');
const fs = require('fs/promises');
const path = require('path');
const { once } = require('events');
const { program } = require('commander');
const superagent = require('superagent');

program
  .helpOption('--help', 'показати довідку')
  .requiredOption('-h, --host <address>', 'адреса, на якій працює сервер')
  .requiredOption('-p, --port <number>', 'порт сервера')
  .requiredOption('-c, --cache <path>', 'шлях до теки кешу');

function sendText(res, status, text, extraHeaders = {}) {
  res.writeHead(status, {
    'Content-Type': 'text/plain; charset=utf-8',
    ...extraHeaders,
  });
  res.end(text);
}

function sendImage(res, image, source) {
  res.writeHead(200, {
    'Content-Type': 'image/jpeg',
    'Content-Length': image.length,
    'X-Cache': source, // HIT = з кешу, MISS = з http.cat
  });
  res.end(image);
}

// Повертає шлях до файлу кешу або null, якщо шлях некоректний.
// Приймаємо лише /ТРИ_ЦИФРИ, наприклад /404 (захист від ../ у шляху).
function getFilePath(cacheDir, urlPath) {
  const match = /^\/(\d{3})$/.exec(urlPath);
  if (!match) return null;
  return path.join(cacheDir, `${match[1]}.jpg`);
}

async function handleGet(res, code, filePath) {
  // 1. Пробуємо прочитати з кешу
  try {
    const cached = await fs.readFile(filePath);
    return sendImage(res, cached, 'HIT');
  } catch (err) {
    if (err.code !== 'ENOENT') throw err; // справжня помилка диска -> 500
  }

  // 2. У кеші немає -> запит до http.cat
  let image;
  try {
    const response = await superagent
      .get(`https://http.cat/${code}`)
      .buffer(true)
      .parse(superagent.parse.image);
    image = response.body;
  } catch (err) {
    return sendText(res, 404, `Картинку для коду ${code} не знайдено`);
  }

  // 3. Спочатку зберігаємо в кеш, потім віддаємо клієнтові
  await fs.writeFile(filePath, image);
  return sendImage(res, image, 'MISS');
}

async function handlePut(req, res, filePath) {
  // тіло запиту приходить потоком: збираємо шматки через async-ітерацію (без колбеків)
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(chunk);
  }
  const body = Buffer.concat(chunks);

  if (body.length === 0) {
    return sendText(res, 400, 'Тіло запиту порожнє: передайте картинку');
  }

  // записує нову картинку або замінює наявну, байти зберігаються без змін
  await fs.writeFile(filePath, body);
  return sendText(res, 201, 'Картинку збережено в кеш');
}

async function main() {
  program.parse();
  const { host, port, cache } = program.opts();

  const portNumber = Number(port);
  if (!Number.isInteger(portNumber) || portNumber < 0 || portNumber > 65535) {
    throw new Error(`Некоректний порт: ${port}`);
  }

  const cacheDir = path.resolve(cache);
  await fs.mkdir(cacheDir, { recursive: true });

  // єдиний дозволений колбек: async-обробник запиту
  const server = http.createServer(async (req, res) => {
    try {
      const { pathname } = new URL(req.url, 'http://localhost');
      const filePath = getFilePath(cacheDir, pathname);

      if (req.method === 'GET') {
        if (!filePath) {
          return sendText(res, 404, 'Невірний шлях. Використовуйте /<код стану>, напр. /404');
        }
        const code = path.basename(filePath, '.jpg');
        return await handleGet(res, code, filePath);
      }

      if (req.method === 'PUT') {
        if (!filePath) {
          return sendText(res, 404, 'Невірний шлях. Використовуйте /<код стану>, напр. /404');
        }
        return await handlePut(req, res, filePath);
      }

      return sendText(res, 405, 'Метод не дозволено', {
        Allow: 'GET, PUT, DELETE',
      });
    } catch (err) {
      console.error(err);
      if (!res.headersSent) {
        sendText(res, 500, 'Внутрішня помилка сервера');
      } else {
        res.end();
      }
    }
  });

  server.listen(portNumber, host);
  await once(server, 'listening');
  console.log(`Сервер працює на http://${host}:${portNumber}, кеш: ${cacheDir}`);
}

main().catch((err) => {
  console.error(`Помилка: ${err.message}`);
  process.exit(1);
});