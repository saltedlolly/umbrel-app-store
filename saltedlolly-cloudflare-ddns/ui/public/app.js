// Cloudflare DDNS settings page.
//
// Data comes from four places, each refreshed only as often as it changes:
//   /api/state          every 5 s: service status, IPs, last update, notifier errors
//   /api/config         on load and after each save (it only changes when saved)
//   /api/domain-status  every 60 s (cached on the server; it asks Cloudflare)
//   socket.io "log"     Live Logs: the last lines on connect, then new lines only
// Refreshing pauses while the tab is hidden.
'use strict';

const $ = (id) => document.getElementById(id);

const el = {
    statusVal: $('statusBoxVal'), statusError: $('statusError'), warning: $('warning'),
    connectionLost: $('connectionLost'),
    start: $('start'), stop: $('stop'),
    ipv4: $('ipv4'), ipv6: $('ipv6'), ipv6Row: $('ipv6Container'),
    ipv4Updated: $('ipv4LastUpdated'), ipv6Updated: $('ipv6LastUpdated'), ipv6UpdatedRow: $('ipv6UpdateContainer'),
    domains: $('summary-settings'), logs: $('logs'), version: $('versionBadge'),
    // Cloudflare Config card
    tokenStatus: $('cfgTokenStatus'), domainsStatus: $('cfgDomainsStatus'),
    proxied: $('proxiedMainSwitch'), ipv4On: $('ipv4MainSwitch'), ipv6On: $('ipv6MainSwitch'),
    ipv6ProxiedWarn: $('ipv6ProxiedWarn'), configMsg: 'configMainSaveMsg',
    configView: $('configMainView'), configEdit: $('configEditView'), editConfig: $('editConfigBtn'),
    editToken: $('edit_CLOUDFLARE_API_TOKEN'), toggleToken: $('toggleTokenBtn'), editDomains: $('edit_DOMAINS'),
    editProxied: $('edit_PROXIED'), editIPv4: $('edit_IPV4_SUPPORT'), editIPv6: $('edit_IPV6_SUPPORT'),
    saveConfig: $('saveConfigBtn'), cancelConfig: $('cancelConfigBtn'), configEditMsg: 'configEditMsg',
    // Notifiers card
    notifiersView: $('notifiersView'), notifiersEdit: $('notifiersEdit'), editNotifiers: $('editNotifiersBtn'),
    saveNotifiers: $('saveNotifiersBtn'), cancelNotifiers: $('cancelNotifiersBtn'),
    notifiersMsg: 'notifiersMainSaveMsg', notifiersEditMsg: 'notifiersEditMsg'
};

// The three notifiers: settings key, switch, warning icon and edit fields
const NOTIFIERS = [
    { key: 'HEALTHCHECKS', service: 'healthchecks', label: 'Healthchecks', sw: $('notifyHealthchecksSwitch'), warn: $('notifyHealthchecksWarn'), url: $('edit_HEALTHCHECKS'), on: $('edit_HEALTHCHECKS_ENABLED') },
    { key: 'UPTIMEKUMA', service: 'uptimekuma', label: 'Uptime Kuma', sw: $('notifyUptimeSwitch'), warn: $('notifyUptimeWarn'), url: $('edit_UPTIMEKUMA'), on: $('edit_UPTIMEKUMA_ENABLED') },
    { key: 'SHOUTRRR', service: 'shoutrrr', label: 'Shoutrrr', sw: $('notifyShoutrrrSwitch'), warn: $('notifyShoutrrrWarn'), url: $('edit_SHOUTRRR'), on: $('edit_SHOUTRRR_ENABLED') }
];

let config = null;        // last /api/config
let state = null;         // last /api/state
let domainResult = null;  // last /api/domain-status

// Switches with a save in flight. Renders skip them, so a refresh can't flip
// a switch back to its old value mid-save (which looked like a lost click).
const savingSwitches = new Set();

// Set after Enable/Disable is clicked, until the wrapper reports the change
let pendingService = null;

// Notifier errors only count once they appear after the page loaded
let notifierErrorSeen = null;

// ---------------------------------------------------------------------------
// Server calls

async function getJSON(url) {
    const r = await fetch(url);
    if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
    return r.json();
}

// Save some settings. The server merges a partial update into what it has
// stored, so callers send only the fields they change.
async function postConfig(fields) {
    const r = await fetch('/api/config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(fields) });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return r.json();
}

// Run fn now and again ms after each run finishes (never two at once). While
// the tab is hidden it waits, and runs as soon as the tab is shown again.
function every(ms, fn) {
    let timer = null;
    let running = false;
    const run = async () => {
        clearTimeout(timer);
        timer = null;
        if (running || document.hidden) return;
        running = true;
        try { await fn(); } catch (e) { console.error(e); }
        running = false;
        timer = setTimeout(run, ms);
    };
    document.addEventListener('visibilitychange', () => { if (!document.hidden) run(); });
    run();
    return run;   // call to refresh now
}

// ---------------------------------------------------------------------------
// Small helpers

const isProxied = (cfg) => !!cfg && (cfg.PROXIED === 'true' || cfg.PROXIED === true);
// An IP family is on unless its provider is "none" (unset means on)
const familyOn = (cfg, key) => !cfg || !cfg[key] || cfg[key] !== 'none';

function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// A screen-reader-friendly status icon
const icon = (emoji, label) => `<span role="img" aria-label="${label}" title="${label}">${emoji}</span>`;

function splitDomains(str) {
    return (str || '').split(',').map(s => s.trim()).filter(Boolean);
}

function validateDomains(str) {
    const parts = splitDomains(str);
    if (!parts.length) return { valid: false, reason: 'none', parts };
    const re = /^(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]{2,63}$/;
    return parts.every(p => re.test(p)) ? { valid: true, parts } : { valid: false, reason: 'invalid', parts };
}

// Names that look like a main domain (example.com, example.co.uk), as opposed
// to a subdomain such as home.example.com
const TWO_PART_SUFFIXES = ['co.uk', 'org.uk', 'me.uk', 'ltd.uk', 'plc.uk', 'net.uk', 'ac.uk', 'gov.uk',
    'com.au', 'net.au', 'org.au', 'co.nz', 'net.nz', 'org.nz', 'co.za', 'com.br', 'co.jp', 'co.in', 'com.mx'];
function looksLikeMainDomain(d) {
    const labels = d.toLowerCase().split('.');
    if (labels.length === 2) return true;
    return labels.length === 3 && TWO_PART_SUFFIXES.includes(labels.slice(1).join('.'));
}

function isValidUrl(s) {
    try { const u = new URL(s); return u.protocol === 'http:' || u.protocol === 'https:'; } catch (e) { return false; }
}

// Shoutrrr URLs use the service as the scheme (discord://, ntfy://,
// generic+https://...), so any scheme:// URL is allowed. No spaces or commas:
// the URLs are stored comma-separated.
const isValidShoutrrrUrl = (s) => /^[a-z][a-z0-9+.-]*:\/\/[^\s,]+$/i.test(s || '');

// A short message under the main view's buttons that disappears by itself
function showTempMessage(id, msg, success = true, timeout = 4000) {
    const m = $(id);
    m.className = success ? 'text-success small p-2' : 'text-danger small p-2';
    m.textContent = msg;
    m.style.display = '';
    setTimeout(() => { m.style.display = 'none'; m.textContent = ''; }, timeout);
}

// A message inside an open edit form (the main view is hidden while editing)
function showFormMessage(id, msg, kind) {
    const m = $(id);
    if (!msg) { m.style.display = 'none'; m.textContent = ''; return; }
    m.className = 'small mt-2 p-2 rounded ' + (kind === 'warn' ? 'bg-warning-subtle text-warning-emphasis' : 'bg-danger-subtle text-danger-emphasis');
    m.textContent = msg;
    m.style.display = '';
}

function setSwitch(sw, checked) { if (!savingSwitches.has(sw)) sw.checked = checked; }

// The page shows its switches and status once both config and state have
// loaded (see .js-state in app.css); after 5 s it shows them regardless
const notReady = new Set(['config', 'state']);
function markReady(part) {
    notReady.delete(part);
    if (!notReady.size) document.body.classList.add('ready');
}
setTimeout(() => document.body.classList.add('ready'), 5000);

// ---------------------------------------------------------------------------
// Rendering

function renderServiceButtons() {
    if (!state) return;
    if (pendingService && (state.enabled === pendingService.enabled || Date.now() > pendingService.until)) {
        pendingService = null;
        el.start.textContent = 'Enable';
        el.stop.textContent = 'Disable';
    }
    if (pendingService) {
        el.start.disabled = el.stop.disabled = true;
        return;
    }
    // Enable needs a token; before the config has loaded, don't block it
    const hasToken = !config || !!config.CLOUDFLARE_API_TOKEN;
    el.start.disabled = state.enabled || !hasToken;
    el.stop.disabled = !state.enabled;
}

function renderTokenStatus() {
    if (!config) return;
    const invalid = !!(state && state.error && /Invalid Cloudflare API token/i.test(state.error));
    el.tokenStatus.innerHTML = !config.CLOUDFLARE_API_TOKEN ? '⚠️ Missing' : (invalid ? '⚠️ Invalid' : icon('✅', 'OK'));
}

function renderState() {
    el.statusVal.textContent = state.enabled ? (state.running ? 'running' : (state.status || 'starting')) : 'disabled';
    el.statusError.textContent = state.error || '';
    renderServiceButtons();
    renderTokenStatus();

    // "Cloudflare Last Updated": the time of the last real record change.
    // Until there has been one: "Already up to date" once Cloudflare has been
    // checked, otherwise "Not checked yet".
    const describe = (t) => t ? new Date(t).toLocaleString() : (state.lastSuccessfulCheck ? 'Already up to date' : 'Not checked yet');
    const ipv6On = familyOn(config, 'IP6_PROVIDER');
    el.ipv4Updated.textContent = describe(state.lastUpdate.ipv4);
    el.ipv6Updated.textContent = describe(state.lastUpdate.ipv6);
    el.ipv6UpdatedRow.style.display = ipv6On ? '' : 'none';

    el.ipv4.textContent = state.publicIp.ipv4 || 'n/a';
    el.ipv6.textContent = state.publicIp.ipv6 || '';
    el.ipv6Row.style.display = (state.publicIp.ipv6 && ipv6On) ? '' : 'none';

    // Staleness is judged by the last successful check, not the last change:
    // a stable home IP can rightly stay unchanged for days
    const ageMin = state.lastSuccessfulCheck ? (Date.now() - new Date(state.lastSuccessfulCheck).getTime()) / 60000 : 0;
    const stale = state.running && ageMin > 15;
    el.warning.textContent = stale ? `No successful check in the last ${Math.round(ageMin)} minutes.` : '';
    el.warning.style.display = stale ? 'block' : 'none';

    // A notifier failure that appeared after the page loaded: show a warning
    // next to it (with the error on hover). It used to switch the notifier
    // off, so one failed ping stopped all later pings.
    const ne = state.notifierError;
    if (notifierErrorSeen === null) notifierErrorSeen = ne ? ne.seq : 0;
    else if (ne && ne.seq > notifierErrorSeen) {
        notifierErrorSeen = ne.seq;
        const n = NOTIFIERS.find(x => x.service === ne.service);
        if (n) { n.warn.style.display = ''; n.warn.title = ne.line; }
    }
}

function renderConfig() {
    const cfg = config;
    renderTokenStatus();
    const dv = validateDomains(cfg.DOMAINS);
    el.domainsStatus.innerHTML = !cfg.DOMAINS ? '⚠️ None' : (dv.valid ? icon('✅', 'OK') : '⚠️ Invalid');

    const proxied = isProxied(cfg);
    const v6On = familyOn(cfg, 'IP6_PROVIDER');
    setSwitch(el.proxied, proxied);
    setSwitch(el.ipv4On, familyOn(cfg, 'IP4_PROVIDER'));
    setSwitch(el.ipv6On, v6On);
    el.ipv6ProxiedWarn.style.display = (v6On && proxied) ? '' : 'none';

    for (const n of NOTIFIERS) {
        setSwitch(n.sw, cfg[`${n.key}_ENABLED`] === 'yes');
        if (!savingSwitches.has(n.sw)) n.sw.disabled = !cfg[n.key];   // nothing to switch on without a URL
    }
    // Refill the edit forms, unless the user is editing them
    if (el.configEdit.style.display === 'none') fillConfigEdit();
    if (el.notifiersEdit.style.display === 'none') fillNotifiersEdit();
    renderServiceButtons();
    renderDomains();
}

// Why a domain is stuck, from the server's reason
const DOMAIN_REASONS = {
    'Zone not found': 'Not found in your Cloudflare account. Check the spelling, and that the domain is in the account the token belongs to.',
    'Auth error': 'Cloudflare refused the token for this domain. Check the token has Edit zone DNS access to it.',
    'Network error': 'Could not reach Cloudflare to check this domain.',
    'Token missing': 'Add a Cloudflare API token in Edit Config.'
};

// The Proxied and Status cells for one IP family
function familyCells(info, family, proxiedWanted, noAddress) {
    const match = info && info[`${family}Match`];
    const proxied = info ? info[`${family}Proxied`] : null;
    let status = icon('⏳', 'Waiting for an update');
    if (noAddress) status = icon('⚠️', 'No address of this type detected');
    else if (match) status = icon('✅', 'Up to date');
    else if (info && (info.status === 'missing' || info.status === 'invalid')) status = icon('⚠️', 'Problem with the token');
    else if (info && info.status === 'error') status = icon('⛔️', 'Could not reach Cloudflare');

    let proxyCell = icon('⛔️', 'No record');
    if (proxied !== null && proxied !== undefined) {
        const yes = '☁️ Yes';
        if (proxied === proxiedWanted) proxyCell = proxied ? yes : 'No';
        else proxyCell = (proxied ? `${yes} ‣ No` : `No ‣ ${yes}`) + ' ' + icon('⏳', 'Changing');
    }
    return `<td class="text-center">${proxyCell}</td><td class="text-center">${status}</td>`;
}

function renderDomains() {
    if (!config) return;
    const domains = splitDomains(config.DOMAINS);
    if (!domains.length) {
        el.domains.innerHTML = '<div class="col-12"><div class="p-2 border rounded">⚠️ No domains configured</div></div>';
        return;
    }
    const v4 = familyOn(config, 'IP4_PROVIDER');
    const v6 = familyOn(config, 'IP6_PROVIDER');
    const proxied = isProxied(config);
    const byDomain = new Map(((domainResult && domainResult.domains) || []).map(x => [x.domain, x]));
    const noIPv6 = !(state && state.publicIp.ipv6);

    const rows = domains.map(d => {
        const info = domainResult ? byDomain.get(d) : null;
        const why = info && info.status !== 'ok' && DOMAIN_REASONS[info.reason];
        let row = `<tr><td>${escapeHtml(d)}${why ? `<div class="small text-muted">${why}</div>` : ''}</td>`;
        if (v4) row += familyCells(info, 'ipv4', proxied, false);
        if (v6) row += familyCells(info, 'ipv6', proxied, noIPv6);
        return row + '</tr>';
    }).join('');

    let head = '<tr><th rowspan="2">Domains</th>';
    if (v4) head += '<th colspan="2" class="text-center">🌐 IPv4 → A Records</th>';
    if (v6) head += '<th colspan="2" class="text-center">🌐 IPv6 → AAAA Records</th>';
    head += '</tr><tr>';
    if (v4) head += '<th class="text-center">Proxied</th><th class="text-center">Status</th>';
    if (v6) head += '<th class="text-center">Proxied</th><th class="text-center">Status</th>';
    head += '</tr>';

    el.domains.innerHTML = `<div class="col-12"><div class="table-responsive"><table class="table table-sm mb-0">
        <thead class="small text-muted">${head}</thead><tbody>${rows}</tbody></table></div></div>`;
}

// ---------------------------------------------------------------------------
// Refreshing

let failures = 0;
async function refreshState() {
    try {
        state = await getJSON('/api/state');
        failures = 0;
        el.connectionLost.hidden = true;
    } catch (e) {
        // Two misses in a row: say so, rather than showing stale data as if
        // it were current
        if (++failures >= 2) el.connectionLost.hidden = false;
        throw e;
    }
    renderState();
    markReady('state');
}

async function refreshConfig() {
    config = await getJSON('/api/config');
    renderConfig();
    markReady('config');
}

async function refreshDomains() {
    domainResult = await getJSON('/api/domain-status');
    renderDomains();
}

// After a save: settings first (fast), then status and the domain table
async function refreshAfterSave() {
    await refreshConfig();
    refreshState().catch(() => { });
    refreshDomainsNow();
}

// ---------------------------------------------------------------------------
// Service: Enable / Disable

// Show "Enabling..." / "Disabling..." straight away and keep both buttons
// disabled until the wrapper reports the new state (or 15 s pass)
async function setService(enable) {
    pendingService = { enabled: enable, until: Date.now() + 15000 };
    (enable ? el.start : el.stop).textContent = enable ? 'Enabling...' : 'Disabling...';
    el.start.disabled = el.stop.disabled = true;
    try {
        const r = await fetch(enable ? '/api/service/start' : '/api/service/stop', { method: 'POST' });
        if (!r.ok) {
            let msg = 'Unknown error';
            try { msg = (await r.json()).error || msg; } catch (e) { }
            throw new Error(msg);
        }
    } catch (e) {
        pendingService = null;
        el.start.textContent = 'Enable';
        el.stop.textContent = 'Disable';
        el.statusError.textContent = (enable ? 'Could not enable: ' : 'Could not disable: ') + e.message;
    }
    refreshState().catch(() => { });
}
el.start.addEventListener('click', () => setService(true));
el.stop.addEventListener('click', () => setService(false));

// ---------------------------------------------------------------------------
// Switches on the main view (each saves at once)

// Save a switch change: the switches are disabled until the save finishes,
// then everything is re-rendered from the server (which also puts a switch
// back if the save failed)
async function saveSwitch(switches, fields, msgId, okMsg, failMsg) {
    switches.forEach(sw => { savingSwitches.add(sw); sw.disabled = true; });
    try {
        await postConfig(fields);
        Object.assign(config, fields);
        showTempMessage(msgId, okMsg, true);
    } catch (e) {
        console.error(failMsg, e);
        showTempMessage(msgId, failMsg, false);
    } finally {
        switches.forEach(sw => { savingSwitches.delete(sw); sw.disabled = false; });
    }
    await refreshAfterSave();
}

el.proxied.addEventListener('change', () => {
    // Turning Proxied off publishes the home IP address in DNS
    if (!el.proxied.checked && !window.confirm('Turn Proxied off?\n\nYour home IP address will be published in DNS for anyone to see, and visitors will connect to your home directly instead of through Cloudflare. Only do this for services that are not websites.')) {
        el.proxied.checked = true;
        return;
    }
    const on = el.proxied.checked;
    saveSwitch([el.proxied], { PROXIED: on ? 'true' : 'false' }, el.configMsg, `Proxied ${on ? 'enabled' : 'disabled'}.`, 'Failed to change Proxied.');
});

function toggleFamily(changed) {
    // At least one of IPv4 and IPv6 must stay on
    if (!el.ipv4On.checked && !el.ipv6On.checked) (changed === el.ipv4On ? el.ipv6On : el.ipv4On).checked = true;
    const name = changed === el.ipv4On ? 'IPv4' : 'IPv6';
    saveSwitch([el.ipv4On, el.ipv6On], {
        IP4_PROVIDER: el.ipv4On.checked ? 'cloudflare.trace' : 'none',
        IP6_PROVIDER: el.ipv6On.checked ? 'cloudflare.trace' : 'none'
    }, el.configMsg, `${name} ${changed.checked ? 'enabled' : 'disabled'}.`, 'Failed to change IP support.');
}
el.ipv4On.addEventListener('change', () => toggleFamily(el.ipv4On));
el.ipv6On.addEventListener('change', () => toggleFamily(el.ipv6On));

for (const n of NOTIFIERS) {
    n.sw.addEventListener('change', () => {
        n.warn.style.display = 'none';
        n.warn.title = '';
        saveSwitch([n.sw], { [`${n.key}_ENABLED`]: n.sw.checked ? 'yes' : 'no' }, el.notifiersMsg,
            `${n.label} ${n.sw.checked ? 'enabled' : 'disabled'}.`, 'Failed to change notifier.');
    });
}

// ---------------------------------------------------------------------------
// Edit Config form

function fillConfigEdit() {
    el.editToken.value = config.CLOUDFLARE_API_TOKEN || '';
    el.editDomains.value = config.DOMAINS || '';
    el.editProxied.checked = isProxied(config);
    el.editIPv4.checked = familyOn(config, 'IP4_PROVIDER');
    el.editIPv6.checked = familyOn(config, 'IP6_PROVIDER');
}

// Clear the form's message, the "Save anyway" state and the shown token
function resetConfigForm() {
    showFormMessage(el.configEditMsg, '');
    delete el.saveConfig.dataset.confirmed;
    el.saveConfig.textContent = 'Save';
    el.editToken.type = 'password';
    el.toggleToken.textContent = 'Show';
}

function showConfigEdit(open) {
    el.configView.style.display = open ? 'none' : '';
    el.configEdit.style.display = open ? '' : 'none';
}

// Opens at once from the config already loaded (waiting for the server first
// made the button seem unresponsive)
el.editConfig.addEventListener('click', (e) => {
    e.preventDefault();
    if (!config) return;
    fillConfigEdit();
    showConfigEdit(true);
});

el.cancelConfig.addEventListener('click', (e) => {
    e.preventDefault();
    resetConfigForm();
    showConfigEdit(false);
});

el.toggleToken.addEventListener('click', () => {
    const show = el.editToken.type === 'password';
    el.editToken.type = show ? 'text' : 'password';
    el.toggleToken.textContent = show ? 'Hide' : 'Show';
});

// At least one of IPv4 and IPv6 must stay on
el.editIPv4.addEventListener('change', () => { if (!el.editIPv4.checked && !el.editIPv6.checked) el.editIPv6.checked = true; });
el.editIPv6.addEventListener('change', () => { if (!el.editIPv4.checked && !el.editIPv6.checked) el.editIPv4.checked = true; });
el.editDomains.addEventListener('input', () => { if (el.saveConfig.dataset.confirmed) resetConfigForm(); });

el.saveConfig.addEventListener('click', async (e) => {
    e.preventDefault();
    const domains = el.editDomains.value.trim();
    const dv = validateDomains(domains);
    if (dv.reason === 'invalid') {
        showFormMessage(el.configEditMsg, 'Domains are invalid. Enter names only, separated by commas, for example home.example.com (no https:// and no slashes).');
        return;
    }
    // A newly added main domain (example.com) may point at a website hosted
    // elsewhere, which this app would replace. Ask once; "Save anyway" goes ahead.
    const saved = splitDomains(config.DOMAINS).map(d => d.toLowerCase());
    const mainDomains = dv.parts.filter(d => looksLikeMainDomain(d) && !saved.includes(d.toLowerCase()));
    if (mainDomains.length && el.saveConfig.dataset.confirmed !== domains) {
        el.saveConfig.dataset.confirmed = domains;
        el.saveConfig.textContent = 'Save anyway';
        showFormMessage(el.configEditMsg, `${mainDomains.join(', ')} looks like a main domain. This app will point it at your home, replacing whatever it points at now (for example a website or email service hosted elsewhere). If that is what you want, click Save anyway. Otherwise use a subdomain such as home.${mainDomains[0]}.`, 'warn');
        return;
    }
    try {
        await postConfig({
            CLOUDFLARE_API_TOKEN: el.editToken.value.trim(),
            DOMAINS: domains,
            PROXIED: el.editProxied.checked ? 'true' : 'false',
            IP4_PROVIDER: el.editIPv4.checked ? 'cloudflare.trace' : 'none',
            IP6_PROVIDER: el.editIPv6.checked ? 'cloudflare.trace' : 'none'
        });
    } catch (err) {
        showFormMessage(el.configEditMsg, 'Save failed: ' + err.message);
        return;
    }
    resetConfigForm();
    showConfigEdit(false);
    showTempMessage(el.configMsg, 'Settings saved.', true);
    await refreshAfterSave();
});

// ---------------------------------------------------------------------------
// Edit Notifiers form

function fillNotifiersEdit() {
    for (const n of NOTIFIERS) {
        n.url.value = n.key === 'SHOUTRRR' ? (config.SHOUTRRR || '').replace(/,/g, '\n') : (config[n.key] || '');
        n.on.checked = config[`${n.key}_ENABLED`] === 'yes';
        n.url.classList.remove('is-invalid');
    }
}

function showNotifiersEdit(open) {
    el.notifiersView.style.display = open ? 'none' : '';
    el.notifiersEdit.style.display = open ? '' : 'none';
}

el.editNotifiers.addEventListener('click', (e) => {
    e.preventDefault();
    if (!config) return;
    fillNotifiersEdit();
    showNotifiersEdit(true);
});

el.cancelNotifiers.addEventListener('click', (e) => {
    e.preventDefault();
    showFormMessage(el.notifiersEditMsg, '');
    showNotifiersEdit(false);   // the form is refilled the next time it opens
});

el.saveNotifiers.addEventListener('click', async (e) => {
    e.preventDefault();
    const fields = {};
    for (const n of NOTIFIERS) {
        n.url.classList.remove('is-invalid');
        const value = n.url.value.trim();
        if (n.key === 'SHOUTRRR') {
            const lines = value.split('\n').map(s => s.trim()).filter(Boolean);
            const bad = lines.find(l => !isValidShoutrrrUrl(l));
            if (bad) {
                n.url.classList.add('is-invalid');
                showFormMessage(el.notifiersEditMsg, bad.includes(',') ? 'Shoutrrr URLs cannot contain commas.' : 'Invalid Shoutrrr URL. Each line must be a URL such as discord://token@id.');
                return;
            }
            fields.SHOUTRRR = lines.join(',');
        } else {
            if (value && !isValidUrl(value)) {
                n.url.classList.add('is-invalid');
                showFormMessage(el.notifiersEditMsg, `Invalid ${n.label} URL. It must start with http:// or https://`);
                return;
            }
            fields[n.key] = value;
        }
        fields[`${n.key}_ENABLED`] = n.on.checked ? 'yes' : 'no';
    }
    try {
        await postConfig(fields);
    } catch (err) {
        showFormMessage(el.notifiersEditMsg, 'Save failed: ' + err.message);
        return;
    }
    showFormMessage(el.notifiersEditMsg, '');
    NOTIFIERS.forEach(n => { n.warn.style.display = 'none'; n.warn.title = ''; });
    showNotifiersEdit(false);
    showTempMessage(el.notifiersMsg, 'Settings saved.', true);
    await refreshAfterSave();
});

// ---------------------------------------------------------------------------
// Live Logs: keeps the last 500 lines; follows new lines while scrolled to
// the bottom, and leaves the view alone while the user is reading further up

const LOG_LINES = 500;
function showLog(text, append) {
    const atBottom = el.logs.scrollHeight - el.logs.scrollTop - el.logs.clientHeight < 40;
    let lines = append ? (el.logs.textContent ? el.logs.textContent.split('\n') : []).concat(text.split('\n')) : text.split('\n');
    if (lines.length > LOG_LINES) lines = lines.slice(-LOG_LINES);
    el.logs.textContent = lines.join('\n');
    if (atBottom || !append) el.logs.scrollTop = el.logs.scrollHeight;
}

const socket = io();
socket.on('log', (text) => showLog(text, false));
socket.on('log-append', (text) => showLog(text, true));

// ---------------------------------------------------------------------------
// Colour theme: light / system / dark, remembered in this browser. The saved
// theme is applied by a small script in index.html before the page is drawn;
// this keeps the picker in step and follows the device while on "system".

const darkQuery = window.matchMedia('(prefers-color-scheme: dark)');
function savedTheme() {
    try { return localStorage.getItem('theme') || 'system'; } catch (e) { return 'system'; }
}
function applyTheme(choice) {
    const dark = choice === 'dark' || (choice === 'system' && darkQuery.matches);
    document.documentElement.setAttribute('data-bs-theme', dark ? 'dark' : 'light');
    document.querySelectorAll('[data-theme-value]').forEach(b => {
        const on = b.dataset.themeValue === choice;
        b.classList.toggle('active', on);
        b.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
}
document.querySelectorAll('[data-theme-value]').forEach(b => b.addEventListener('click', () => {
    try { localStorage.setItem('theme', b.dataset.themeValue); } catch (e) { }
    applyTheme(b.dataset.themeValue);
}));
darkQuery.addEventListener('change', () => { if (savedTheme() === 'system') applyTheme('system'); });
applyTheme(savedTheme());

// ---------------------------------------------------------------------------
// Start

// "Report Issue" opens a new GitHub issue with the version filled in and a
// reminder to update first (the problem may already be fixed)
function setReportIssueLink(version) {
    const body = [
        `**App:** Cloudflare DDNS (saltedlolly App Store)`,
        `**Version:** ${version}`,
        '',
        '> Before reporting, please make sure you are running the latest version: open the App Store on your Umbrel and install any update for Cloudflare DDNS. The problem may already be fixed.',
        '',
        '**What happened?**',
        '',
        '',
        '**What did you expect to happen?**',
        '',
        '',
        '**Steps to reproduce**',
        '',
        '',
        '**Relevant lines from Live Logs** (please remove anything private, such as your domain names and IP addresses)',
        '```',
        '',
        '```'
    ].join('\n');
    const params = new URLSearchParams({ title: `[Cloudflare DDNS] `, body });
    $('reportIssue').href = `https://github.com/saltedlolly/umbrel-app-store/issues/new?${params}`;
}

// Version badge, and a notice when the app store has a newer version (the
// server checks the store once an hour; the page asks it every 15 minutes)
async function refreshVersion() {
    let v = { version: 'unknown' };
    try { v = await getJSON('/api/version'); } catch (e) { }
    el.version.textContent = v.version;
    setReportIssueLink(v.version);
    const notice = $('updateNotice');
    notice.hidden = !v.updateAvailable;
    if (v.updateAvailable) {
        notice.textContent = `Update available: ${v.latestVersion}`;
        notice.title = 'Install it from the App Store on your Umbrel (it can take a few minutes to appear there).';
    }
}
every(15 * 60 * 1000, refreshVersion);
refreshConfig().catch(e => console.error(e)).finally(() => {
    every(5000, refreshState);
});
const refreshDomainsNow = every(60000, refreshDomains);
