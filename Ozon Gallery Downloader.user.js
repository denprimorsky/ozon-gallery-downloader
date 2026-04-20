// ==UserScript==
// @name         Загрузчик карточек Ozon
// @namespace    ozon-gallery-downloader
// @version      1.0.0
// @description  Скрипт для скачивания карточек товаров из галереи на Ozon прямо в выбранную папку на компьютере
// @author       denprimorsky
// @match        https://www.ozon.ru/product/*
// @grant        GM_xmlhttpRequest
// @grant        GM_registerMenuCommand
// @homepage     https://github.com/denprimorsky/ozon-gallery-downloader
// @updateURL    https://github.com/denprimorsky/ozon-gallery-downloader/raw/refs/heads/main/Ozon%20Gallery%20Downloader.user.js
// @downloadURL  https://github.com/denprimorsky/ozon-gallery-downloader/raw/refs/heads/main/Ozon%20Gallery%20Downloader.user.js
// @connect      ir.ozone.ru
// @connect      ozone.ru
// ==/UserScript==

(function() {
    'use strict';

    // Задержка между загрузками файлов (мс). Увеличь, если браузер тормозит или блокирует запросы.
    const DOWNLOAD_DELAY_MS = 250;

    // Максимальная длина названия товара в имени файла (без учёта артикула и номера).
    // Если название длиннее — обрежется по запятой или по последнему пробелу до этого лимита.
    const NAME_LIMIT_CHARS = 40;

    let isRunning = false;

    GM_registerMenuCommand('📥 Скачать карточки в папку', async () => {
        if (isRunning) return;
        isRunning = true;

        if (typeof window.showDirectoryPicker !== 'function') {
            const s = createStatus('File System API недоступен. Используйте Chrome/Edge.');
            setTimeout(() => { s.remove(); isRunning = false; }, 3000);
            return;
        }

        const status = createStatus('Ищем карточки...');
        try {
            const tasks = getGalleryTasks();
            if (!tasks.length) {
                updateStatus(status, 'Карточки не найдены. Пролистай галерею.', '#b91c1c');
                setTimeout(() => { status.remove(); isRunning = false; }, 3000);
                return;
            }

            updateStatus(status, 'Выберите папку...');

            let rootDir;
            try {
                rootDir = await window.showDirectoryPicker();
            } catch (e) {
                if (e.name === 'AbortError') {
                    updateStatus(status, 'Выбор отменён.', '#f59e0b');
                } else {
                    updateStatus(status, 'Ошибка доступа к папке.', '#b91c1c');
                }
                setTimeout(() => { status.remove(); isRunning = false; }, 3000);
                return;
            }

            const { name: titleBase, sku } = getProductInfo();
            const folderName = `${titleBase} (${sku})`
                .replace(/[\\/:*?"<>|]/g, '_')
                .substring(0, 80);

            updateStatus(status, `Папка: ${folderName}`);
            const productDir = await rootDir.getDirectoryHandle(folderName, { create: true });

            let existingCount = 0;
            try {
                for await (const entry of productDir.values()) {
                    if (entry.kind === 'file' && entry.name.endsWith('.jpg')) {
                        existingCount++;
                    }
                }
            } catch (_) {}

            const action = existingCount > 0 ? `Перезаписываю ${tasks.length} из ${existingCount}...` : `Качаю ${tasks.length} карточек...`;
            updateStatus(status, action);

            let success = 0;
            for (let i = 0; i < tasks.length; i++) {
                updateStatus(status, `${i + 1}/${tasks.length}`);
                try {
                    const blob = await fetchBlob(tasks[i].url);
                    await saveToFS(blob, tasks[i].name, productDir);
                    success++;
                    await sleep(DOWNLOAD_DELAY_MS);
                } catch (e) {
                    console.warn(`Пропуск ${tasks[i].name}:`, e);
                }
            }

            const msg = existingCount > 0
                ? `Готово! Перезаписано: ${success}`
                : `Готово! Сохранено: ${success}`;
            updateStatus(status, msg, '#166534');
            setTimeout(() => { status.remove(); isRunning = false; }, 4000);

        } catch (err) {
            console.error(err);
            updateStatus(status, 'Ошибка: ' + err.message, '#b91c1c');
            setTimeout(() => { status.remove(); isRunning = false; }, 3000);
        }
    });

    function getGalleryTasks() {
        const gallery = document.querySelector('.pdp_aa8');
        if (!gallery) return [];

        const { name: titleBase, sku } = getProductInfo();
        const ext = 'jpg';
        const urls = new Set();

        gallery.querySelectorAll('.pdp_w9').forEach(item => {
            if (item.classList.contains('pdp_ba')) return;
            const img = item.querySelector('img');
            if (img?.src) {
                urls.add(img.src.replace(/\/wc\d+\//, '/wc2500/'));
            }
        });

        return Array.from(urls).map((url, i) => ({
            url,
            name: `${titleBase} (${sku})_${i + 1}.${ext}`
        }));
    }

    function getProductInfo() {
        let raw = document.title || '';
        const skuMatch = raw.match(/\((\d{7,})\)/);
        const sku = skuMatch ? skuMatch[1] : '00000000';

        let clean = raw
            .replace(/\s*купить на OZON.*$/i, '')
            .replace(/\s*\(?\d{7,}\)?\s*$/, '')
            .replace(/[\\/:*?"<>|]/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();

        return { name: applyTruncationLogic(clean), sku };
    }

    function applyTruncationLogic(text) {
        if (text.length <= NAME_LIMIT_CHARS) return text;

        let commaIndex = text.indexOf(',');
        if (commaIndex !== -1 && commaIndex < NAME_LIMIT_CHARS) {
            return text.substring(0, commaIndex).trim();
        }

        let lastSpace = text.lastIndexOf(' ', NAME_LIMIT_CHARS - 3);
        if (lastSpace > 10) return text.substring(0, lastSpace);

        return text.substring(0, NAME_LIMIT_CHARS - 3) + '...';
    }

    function fetchBlob(url) {
        return new Promise((resolve, reject) => {
            GM_xmlhttpRequest({
                method: 'GET',
                url,
                responseType: 'blob',
                onload: (r) => r.status === 200 ? resolve(r.response) : reject(new Error(`HTTP ${r.status}`)),
                onerror: reject
            });
        });
    }

    async function saveToFS(blob, filename, dirHandle) {
        const fileHandle = await dirHandle.getFileHandle(filename, { create: true });
        const writable = await fileHandle.createWritable();
        await writable.write(blob);
        await writable.close();
    }

    function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

    function createStatus(text) {
        const el = document.createElement('div');
        el.style.cssText = 'position:fixed;bottom:30px;right:30px;background:#111;color:#fff;padding:12px 16px;border-radius:8px;z-index:99999;font-family:system-ui;font-size:13px;box-shadow:0 4px 12px rgba(0,0,0,0.5);max-width:400px;';
        el.textContent = text;
        document.body.appendChild(el);
        return el;
    }
    function updateStatus(el, text, bg) {
        el.textContent = text;
        if (bg) el.style.background = bg;
    }
})();