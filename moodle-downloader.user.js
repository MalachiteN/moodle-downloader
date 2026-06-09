// ==UserScript==
// @name         Moodle Downloader
// @namespace    http://tampermonkey.net/
// @version      1.0
// @description  Download all course resources from your Moodle
// @author       MalachiteN
// @match        https://moodle.example.edu.cn/course/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(function() {
    'use strict';

    const CONFIG = {
        exts: ['.pdf', '.doc', '.docx', '.ppt', '.pptx', '.xls', '.xlsx', '.zip', '.rar', '.txt', '.csv'],
        concurrency: 3,
        delay: 500,
    };

    async function loadJSZip() {
        if (window.JSZip) return window.JSZip;
        return new Promise((resolve, reject) => {
            const script = document.createElement('script');
            script.src = 'https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js';
            const origDefine = window.define;
            const origModule = window.module;
            const origExports = window.exports;
            window.define = undefined;
            window.module = undefined;
            window.exports = undefined;
            script.onload = () => {
                window.define = origDefine;
                window.module = origModule;
                window.exports = origExports;
                if (window.JSZip) resolve(window.JSZip);
                else reject(new Error('JSZip not mounted'));
            };
            script.onerror = () => {
                window.define = origDefine;
                window.module = origModule;
                window.exports = origExports;
                reject(new Error('Failed to load JSZip'));
            };
            document.head.appendChild(script);
        });
    }

    function sanitize(name) {
        return name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').trim();
    }

    function getExt(filename) {
        const m = filename.match(/\.([a-zA-Z0-9]+)$/);
        return m ? '.' + m[1].toLowerCase() : '';
    }

    function parseFilename(resp) {
        const cd = resp.headers.get('content-disposition');
        if (cd) {
            const m = cd.match(/filename[^;=\n]*=(['"]?)([^'"\n]*)\1/);
            if (m) {
                try { return decodeURIComponent(m[2]); } catch(e) { return m[2]; }
            }
        }
        try {
            const url = new URL(resp.url);
            const name = url.pathname.substring(url.pathname.lastIndexOf('/') + 1);
            return name ? decodeURIComponent(name) : null;
        } catch(e) { return null; }
    }

    function extractSections() {
        const sections = [];
        const sel = '.course-content .section, .course-content .topics .section, .course-content .weeks .section, #course-content .section';
        const els = document.querySelectorAll(sel);
        els.forEach((sec, idx) => {
            let title = '';
            const tsel = ['.sectionname', '.content .sectionname', '.section-title', 'h3', 'h4'];
            for (const s of tsel) {
                const el = sec.querySelector(s);
                if (el && el.textContent.trim()) { title = el.textContent.trim(); break; }
            }
            if (!title) title = 'Section ' + (idx + 1);
            title = sanitize(title);

            const resources = [];
            const acts = sec.querySelectorAll('.activity, .activityinstance, li.activity');
            acts.forEach(act => {
                const link = act.querySelector('a');
                if (!link || !link.href) return;
                const href = link.href;
                const text = link.textContent.trim();
                if (href.includes('mod/resource/view.php')) {
                    resources.push({ type: 'resource', url: href, name: text });
                } else if (href.includes('mod/folder/view.php')) {
                    resources.push({ type: 'folder', url: href, name: text });
                } else if (CONFIG.exts.includes(getExt(href))) {
                    resources.push({ type: 'direct', url: href, name: text || href.substring(href.lastIndexOf('/') + 1) });
                }
            });
            if (resources.length) sections.push({ title, resources });
        });
        return sections;
    }

    async function downloadFile(url, preferredName) {
        const resp = await fetch(url, { credentials: 'include', redirect: 'follow' });
        if (!resp.ok) throw new Error('HTTP ' + resp.status);
        const blob = await resp.blob();
        const ct = resp.headers.get('content-type') || '';
        if (ct.includes('text/html') && blob.size < 1024 * 1024) {
            const text = await blob.text();
            const doc = new DOMParser().parseFromString(text, 'text/html');
            const dl = doc.querySelector('.resourceworkaround a, .resourcepdf a, #resourceobject a, a[href*="pluginfile.php"]');
            if (dl && dl.href && dl.href !== url) return downloadFile(dl.href, preferredName);
            const emb = doc.querySelector('embed[src], object[data]');
            if (emb) {
                const src = emb.src || emb.data;
                if (src) return downloadFile(src, preferredName);
            }
            throw new Error('Cannot resolve file URL');
        }
        let filename = parseFilename(resp) || preferredName || 'unknown';
        filename = sanitize(filename);
        if (!getExt(filename)) {
            const map = {
                'application/pdf': '.pdf', 'application/msword': '.doc',
                'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
                'application/vnd.ms-powerpoint': '.ppt',
                'application/vnd.openxmlformats-officedocument.presentationml.presentation': '.pptx',
                'application/vnd.ms-excel': '.xls',
                'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': '.xlsx',
                'application/zip': '.zip', 'text/plain': '.txt', 'text/csv': '.csv',
            };
            for (const [mime, ext] of Object.entries(map)) {
                if (ct.includes(mime)) { filename += ext; break; }
            }
        }
        return { blob, filename };
    }

    async function fetchFolder(url) {
        const resp = await fetch(url, { credentials: 'include' });
        const text = await resp.text();
        const doc = new DOMParser().parseFromString(text, 'text/html');
        const files = [];
        doc.querySelectorAll('a[href*="pluginfile.php"]').forEach(link => {
            const href = link.href;
            const name = link.textContent.trim() || href.substring(href.lastIndexOf('/') + 1);
            if (name && CONFIG.exts.includes(getExt(name))) {
                files.push({ url: href, name: sanitize(name) });
            }
        });
        return files;
    }

    async function asyncPool(n, arr, fn) {
        const executing = new Set();
        const ret = [];
        for (const item of arr) {
            const p = Promise.resolve().then(() => fn(item));
            ret.push(p);
            executing.add(p);
            const clean = () => executing.delete(p);
            p.then(clean).catch(clean);
            if (executing.size >= n) await Promise.race(executing);
        }
        return Promise.all(ret);
    }

    async function startDownload() {
        const btn = document.getElementById('moodle-dl-btn');
        if (!btn) return;
        btn.disabled = true;
        btn.textContent = 'Loading JSZip...';

        try {
            const JSZip = await loadJSZip();
            btn.textContent = 'Scanning...';

            const sections = extractSections();
            if (!sections.length) {
                btn.textContent = 'No resources found';
                setTimeout(() => { btn.textContent = 'Download All'; btn.disabled = false; }, 3000);
                return;
            }

            const tasks = [];
            for (const sec of sections) {
                for (const res of sec.resources) {
                    if (res.type === 'resource') {
                        tasks.push({ section: sec.title, url: res.url + (res.url.includes('?') ? '&' : '?') + 'forcedownload=1', name: res.name });
                    } else if (res.type === 'folder') {
                        tasks.push({ section: sec.title, url: res.url, name: res.name, isFolder: true });
                    } else {
                        tasks.push({ section: sec.title, url: res.url, name: res.name });
                    }
                }
            }

            const total = tasks.length;
            let done = 0;
            let failed = 0;
            const zip = new JSZip();
            const failedList = [];
            const usedNames = new Set();

            function uniqueName(section, filename) {
                let name = section + '/' + filename;
                if (!usedNames.has(name)) {
                    usedNames.add(name);
                    return name;
                }
                const ext = getExt(filename);
                const base = ext ? filename.slice(0, -ext.length) : filename;
                let i = 1;
                while (true) {
                    name = section + '/' + base + '_' + i + ext;
                    if (!usedNames.has(name)) {
                        usedNames.add(name);
                        return name;
                    }
                    i++;
                }
            }

            btn.textContent = 'Downloading 0/' + total;

            await asyncPool(CONFIG.concurrency, tasks, async (task) => {
                try {
                    if (task.isFolder) {
                        const files = await fetchFolder(task.url);
                        for (const f of files) {
                            try {
                                const { blob, filename } = await downloadFile(f.url, f.name);
                                zip.file(uniqueName(task.section + '/' + (task.name || 'folder'), filename), blob);
                            } catch (e) {
                                failedList.push('[folder] ' + f.name + ': ' + e.message);
                            }
                        }
                    } else {
                        const { blob, filename } = await downloadFile(task.url, task.name);
                        zip.file(uniqueName(task.section, filename), blob);
                    }
                    done++;
                } catch (e) {
                    failed++;
                    failedList.push((task.name || task.url) + ': ' + e.message);
                    console.error('Download failed:', task, e);
                }
                btn.textContent = 'Downloading ' + done + '/' + total;
                await new Promise(r => setTimeout(r, CONFIG.delay));
            });

            if (failedList.length) zip.file('_FAILED.txt', failedList.join('\n'));

            btn.textContent = 'Packing ZIP...';
            const blob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = sanitize(document.title.replace(/-\s*Moodle.*$/i, '').trim() || 'course') + '.zip';
            document.body.appendChild(a);
            a.click();
            a.remove();
            URL.revokeObjectURL(url);

            btn.textContent = 'Done (' + done + '/' + total + ')';
            setTimeout(() => { btn.textContent = 'Download All'; btn.disabled = false; }, 3000);

        } catch (err) {
            console.error('[MoodleDL]', err);
            btn.textContent = 'Error: ' + err.message;
            setTimeout(() => { btn.textContent = 'Download All'; btn.disabled = false; }, 5000);
        }
    }

    function init() {
        const nav = document.querySelector('.primary-navigation');
        if (!nav) {
            console.log('[MoodleDL] .primary-navigation not found');
            return;
        }
        if (document.getElementById('moodle-dl-btn')) return;

        const btn = document.createElement('button');
        btn.id = 'moodle-dl-btn';
        btn.type = 'button';
        btn.textContent = 'Download All';

        // Looks like a plain hyperlink
        btn.style.background = 'transparent';
        btn.style.border = 'none';
        btn.style.color = '#000';
        btn.style.textDecoration = 'underline';
        btn.style.cursor = 'pointer';
        btn.style.font = 'inherit';
        btn.style.padding = '0';
        btn.style.margin = '0';

        btn.addEventListener('click', startDownload);

        // Insert as sibling after .primary-navigation
        if (nav.nextSibling) {
            nav.parentNode.insertBefore(btn, nav.nextSibling);
        } else {
            nav.parentNode.appendChild(btn);
        }

        console.log('[MoodleDL] Button injected');
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
