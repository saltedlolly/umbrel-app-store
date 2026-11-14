/*
 * saltedlolly support dialog (shared by all saltedlolly app UIs).
 * Master copy: assets/saltedlolly/support/ in saltedlolly/umbrel-app-store.
 * Each UI ships a copy of this file, support-dialog.css and support.json.
 *
 * Usage: give the footer's Donate link data-support-dialog. Clicking it opens
 * a dialog with the bio and donation methods instead of following the link
 * (the link's own href still works with JavaScript off, or with Cmd/Ctrl-click).
 * Optional: data-support-avatar="/path/to/avatar.png".
 *
 * The dialog shows the bundled support.json at once. When it opens, it also
 * asks GitHub for the latest copy (so new donation methods appear without an
 * app release) and swaps it in if it is valid. Nothing is fetched until the
 * dialog is opened. All text is inserted as text, never as HTML, and links
 * are only shown for the hosts listed below.
 */
(function () {
    'use strict';

    var LOCAL_URL = '/support.json';
    var REMOTE_URL = 'https://raw.githubusercontent.com/saltedlolly/umbrel-app-store/master/assets/saltedlolly/support/support.json';
    var ALLOWED_HOSTS = [
        'ko-fi.com', 'github.com', 'saltedlolly.com', 'www.saltedlolly.com',
        'paypal.me', 'www.paypal.com', 'buymeacoffee.com', 'www.buymeacoffee.com',
        'liberapay.com', 'opencollective.com', 'patreon.com', 'www.patreon.com'
    ];

    function safeUrl(u) {
        try {
            var url = new URL(String(u));
            return url.protocol === 'https:' && ALLOWED_HOSTS.indexOf(url.hostname) !== -1 ? url.href : null;
        } catch (e) {
            return null;
        }
    }

    function text(v, max) {
        return typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null;
    }

    // Returns a clean copy of the support data, or null if it isn't usable
    function validate(d) {
        if (!d || typeof d !== 'object' || d.schema !== 1 || !Array.isArray(d.methods)) return null;
        var methods = d.methods.slice(0, 6).map(function (m) {
            var url = m && safeUrl(m.url);
            var label = m && text(m.label, 60);
            return url && label ? { url: url, label: label, note: text(m.note, 120), primary: m.primary === true } : null;
        }).filter(Boolean);
        if (!methods.length) return null;
        return {
            title: text(d.title, 60) || 'Support saltedlolly',
            name: text(d.name, 60),
            bio: (Array.isArray(d.bio) ? d.bio : []).slice(0, 4).map(function (p) { return text(p, 400); }).filter(Boolean),
            methods: methods,
            thanks: text(d.thanks, 120),
            website: safeUrl(d.website)
        };
    }

    function getJson(url, ms) {
        var ctrl = 'AbortController' in window ? new AbortController() : null;
        var timer = ctrl && setTimeout(function () { ctrl.abort(); }, ms);
        return fetch(url, { cache: 'no-cache', signal: ctrl ? ctrl.signal : undefined })
            .then(function (r) { return r.ok ? r.json() : null; })
            .catch(function () { return null; })
            .then(function (j) { if (timer) clearTimeout(timer); return validate(j); });
    }

    function el(tag, cls, txt) {
        var e = document.createElement(tag);
        if (cls) e.className = cls;
        if (txt) e.textContent = txt;
        return e;
    }

    var dialog = null, shown = null, avatar = '/saltedlolly-avatar-128.png';

    function render(data) {
        shown = JSON.stringify(data);
        dialog.textContent = '';

        var close = el('button', 'sd-close');
        close.type = 'button';
        close.setAttribute('aria-label', 'Close');
        close.textContent = '×';
        close.addEventListener('click', function () { dialog.close(); });
        dialog.appendChild(close);

        var head = el('div', 'sd-head');
        var img = el('img', 'sd-avatar');
        img.src = avatar;
        img.alt = '';
        img.width = 56;
        img.height = 56;
        head.appendChild(img);
        var titles = el('div');
        var h = el('h2', 'sd-title', data.title);
        h.id = 'sd-title';
        titles.appendChild(h);
        if (data.name) titles.appendChild(el('div', 'sd-name', data.name));
        head.appendChild(titles);
        dialog.appendChild(head);

        data.bio.forEach(function (p) { dialog.appendChild(el('p', 'sd-bio', p)); });

        var list = el('div', 'sd-methods');
        data.methods.forEach(function (m) {
            var a = el('a', 'sd-method' + (m.primary ? ' sd-primary' : ''));
            a.href = m.url;
            a.target = '_blank';
            a.rel = 'noopener';
            var label = el('span', 'sd-label');
            if (m.primary) {
                var heart = el('span', 'sd-heart', '♥');
                heart.setAttribute('aria-hidden', 'true');
                label.appendChild(heart);
            }
            label.appendChild(document.createTextNode(m.label));
            a.appendChild(label);
            if (m.note) a.appendChild(el('span', 'sd-note', m.note));
            list.appendChild(a);
        });
        dialog.appendChild(list);

        if (data.thanks || data.website) {
            var foot = el('p', 'sd-thanks', data.thanks ? data.thanks + ' ' : '');
            if (data.website) {
                var w = el('a', null, new URL(data.website).hostname.replace(/^www\./, ''));
                w.href = data.website;
                w.target = '_blank';
                w.rel = 'noopener';
                foot.appendChild(w);
            }
            dialog.appendChild(foot);
        }
    }

    function open(fallbackHref) {
        if (!dialog) {
            dialog = el('dialog', 'sd');
            dialog.setAttribute('aria-labelledby', 'sd-title');
            // Clicking the dark area around the dialog closes it
            dialog.addEventListener('click', function (e) { if (e.target === dialog) dialog.close(); });
            document.body.appendChild(dialog);
        }
        getJson(LOCAL_URL, 3000).then(function (local) {
            // No usable bundled copy: offer the footer link's own address
            render(local || validate({ schema: 1, methods: [{ label: 'Donate', url: fallbackHref, primary: true }] }));
            if (!dialog.open) dialog.showModal();
            getJson(REMOTE_URL, 5000).then(function (remote) {
                if (remote && JSON.stringify(remote) !== shown && dialog.open) {
                    render(remote);
                    dialog.querySelector('.sd-close').focus();
                }
            });
        });
    }

    document.addEventListener('click', function (e) {
        var link = e.target.closest && e.target.closest('[data-support-dialog]');
        if (!link || e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
        if (typeof HTMLDialogElement !== 'function') return; // very old browser: follow the link
        e.preventDefault();
        if (link.getAttribute('data-support-avatar')) avatar = link.getAttribute('data-support-avatar');
        open(link.href);
    });
})();
