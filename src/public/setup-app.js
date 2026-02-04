// Served at /setup/app.js
// Modern setup wizard logic

(function () {
  // Elements
  var statusEl = document.getElementById('status');
  var statusDotEl = document.getElementById('statusDot');
  var authGroupEl = document.getElementById('authGroup');
  var authChoiceEl = document.getElementById('authChoice');
  var logEl = document.getElementById('log');
  var loadingOverlay = document.getElementById('loadingOverlay');

  // Summary elements
  var summaryProvider = document.getElementById('summaryProvider');
  var summaryAuth = document.getElementById('summaryAuth');
  var summaryKey = document.getElementById('summaryKey');
  var summaryTelegram = document.getElementById('summaryTelegram');
  var summaryDiscord = document.getElementById('summaryDiscord');
  var summarySlack = document.getElementById('summarySlack');

  // Debug console
  var consoleCmdEl = document.getElementById('consoleCmd');
  var consoleArgEl = document.getElementById('consoleArg');
  var consoleRunEl = document.getElementById('consoleRun');
  var consoleOutEl = document.getElementById('consoleOut');

  // Config editor
  var configPathEl = document.getElementById('configPath');
  var configTextEl = document.getElementById('configText');
  var configReloadEl = document.getElementById('configReload');
  var configSaveEl = document.getElementById('configSave');
  var configOutEl = document.getElementById('configOut');

  // UI Link
  var openUiLink = document.getElementById('openUiLink');

  // Input elements for summary
  var authSecretEl = document.getElementById('authSecret');
  var telegramTokenEl = document.getElementById('telegramToken');
  var discordTokenEl = document.getElementById('discordToken');
  var slackBotTokenEl = document.getElementById('slackBotToken');
  var slackAppTokenEl = document.getElementById('slackAppToken');

  function setStatus(text, state) {
    statusEl.textContent = text;
    statusDotEl.className = 'status-dot';
    if (state === 'ready') statusDotEl.classList.add('ready');
    else if (state === 'error') statusDotEl.classList.add('error');
  }

  function maskToken(token) {
    if (!token || token.length < 8) return token ? '••••••••' : '—';
    return token.slice(0, 4) + '••••' + token.slice(-4);
  }

  function updateSummary() {
    var providerText = authGroupEl.options[authGroupEl.selectedIndex]?.text || '—';
    var authText = authChoiceEl.options[authChoiceEl.selectedIndex]?.text || '—';

    summaryProvider.textContent = providerText.split(' - ')[0];
    summaryAuth.textContent = authText.split(' - ')[0];
    summaryKey.textContent = maskToken(authSecretEl.value);
    summaryTelegram.textContent = maskToken(telegramTokenEl.value);
    summaryDiscord.textContent = maskToken(discordTokenEl.value);

    var slack = slackBotTokenEl.value || slackAppTokenEl.value;
    summarySlack.textContent = maskToken(slack);
  }

  function renderAuth(groups) {
    authGroupEl.innerHTML = '';
    for (var i = 0; i < groups.length; i++) {
      var g = groups[i];
      var opt = document.createElement('option');
      opt.value = g.value;
      opt.textContent = g.label + (g.hint ? ' — ' + g.hint : '');
      authGroupEl.appendChild(opt);
    }

    authGroupEl.onchange = function () {
      var sel = null;
      for (var j = 0; j < groups.length; j++) {
        if (groups[j].value === authGroupEl.value) sel = groups[j];
      }
      authChoiceEl.innerHTML = '';
      var opts = (sel && sel.options) ? sel.options : [];
      for (var k = 0; k < opts.length; k++) {
        var o = opts[k];
        var opt2 = document.createElement('option');
        opt2.value = o.value;
        opt2.textContent = o.label + (o.hint ? ' — ' + o.hint : '');
        authChoiceEl.appendChild(opt2);
      }
      updateSummary();
    };

    authChoiceEl.onchange = updateSummary;
    authGroupEl.onchange();
  }

  function httpJson(url, opts) {
    opts = opts || {};
    opts.credentials = 'same-origin';
    return fetch(url, opts).then(function (res) {
      if (!res.ok) {
        return res.text().then(function (t) {
          throw new Error('HTTP ' + res.status + ': ' + (t || res.statusText));
        });
      }
      return res.json();
    });
  }

  function showLoading(show) {
    if (show) {
      loadingOverlay.classList.add('active');
    } else {
      loadingOverlay.classList.remove('active');
    }
  }

  function refreshStatus() {
    setStatus('Starting engine... (15-20s)', 'loading');
    return httpJson('/setup/api/status').then(function (j) {
      var ver = j.openclawVersion ? (' • v' + j.openclawVersion) : '';
      if (j.configured) {
        setStatus('Configured' + ver, 'ready');
      } else {
        setStatus('Ready for setup' + ver, 'ready');
      }
      renderAuth(j.authGroups || []);

      // Update UI link with token
      if (j.gatewayToken && openUiLink) {
        openUiLink.href = '/openclaw?token=' + encodeURIComponent(j.gatewayToken);
      }

      if (j.channelsAddHelp && j.channelsAddHelp.indexOf('telegram') === -1) {
        logEl.textContent += 'Note: Telegram not available in this build.\n';
      }

      // Load config editor
      if (configReloadEl && configTextEl) {
        loadConfigRaw();
      }

    }).catch(function (e) {
      setStatus('Error: ' + String(e), 'error');
    });
  }

  // Listen for input changes to update summary
  [authSecretEl, telegramTokenEl, discordTokenEl, slackBotTokenEl, slackAppTokenEl].forEach(function (el) {
    if (el) el.addEventListener('input', updateSummary);
  });

  // Run setup
  document.getElementById('run').onclick = function () {
    var payload = {
      flow: document.getElementById('flow').value,
      authChoice: authChoiceEl.value,
      authSecret: authSecretEl.value,
      telegramToken: telegramTokenEl.value,
      discordToken: discordTokenEl.value,
      slackBotToken: slackBotTokenEl.value,
      slackAppToken: slackAppTokenEl.value
    };

    logEl.textContent = 'Starting setup...\n';
    showLoading(true);

    fetch('/setup/api/run', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload)
    }).then(function (res) {
      return res.text();
    }).then(function (text) {
      var j;
      try { j = JSON.parse(text); } catch (_e) { j = { ok: false, output: text }; }
      logEl.textContent += (j.output || JSON.stringify(j, null, 2));
      return refreshStatus();
    }).catch(function (e) {
      logEl.textContent += '\nError: ' + String(e) + '\n';
    }).finally(function () {
      showLoading(false);
    });
  };

  // Pairing approve
  var pairingBtn = document.getElementById('pairingApprove');
  if (pairingBtn) {
    pairingBtn.onclick = function () {
      var channel = prompt('Enter channel (telegram or discord):');
      if (!channel) return;
      channel = channel.trim().toLowerCase();
      if (channel !== 'telegram' && channel !== 'discord') {
        alert('Channel must be "telegram" or "discord"');
        return;
      }
      var code = prompt('Enter pairing code (e.g. 3EY4PUYS):');
      if (!code) return;
      logEl.textContent += '\nApproving pairing for ' + channel + '...\n';
      fetch('/setup/api/pairing/approve', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ channel: channel, code: code.trim() })
      }).then(function (r) { return r.text(); })
        .then(function (t) { logEl.textContent += t + '\n'; })
        .catch(function (e) { logEl.textContent += 'Error: ' + String(e) + '\n'; });
    };
  }

  // Reset
  document.getElementById('reset').onclick = function () {
    if (!confirm('Reset setup? This deletes the config so you can start over.')) return;
    logEl.textContent = 'Resetting...\n';
    fetch('/setup/api/reset', { method: 'POST', credentials: 'same-origin' })
      .then(function (res) { return res.text(); })
      .then(function (t) { logEl.textContent += t + '\n'; return refreshStatus(); })
      .catch(function (e) { logEl.textContent += 'Error: ' + String(e) + '\n'; });
  };

  // Debug console
  function runConsole() {
    if (!consoleCmdEl || !consoleRunEl) return;
    var cmd = consoleCmdEl.value;
    var arg = consoleArgEl ? consoleArgEl.value : '';
    if (consoleOutEl) consoleOutEl.textContent = 'Running ' + cmd + '...\n';

    return httpJson('/setup/api/console/run', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cmd: cmd, arg: arg })
    }).then(function (j) {
      if (consoleOutEl) consoleOutEl.textContent = (j.output || JSON.stringify(j, null, 2));
      return refreshStatus();
    }).catch(function (e) {
      if (consoleOutEl) consoleOutEl.textContent += '\nError: ' + String(e) + '\n';
    });
  }

  if (consoleRunEl) {
    consoleRunEl.onclick = runConsole;
  }

  // Config editor
  function loadConfigRaw() {
    if (!configTextEl) return;
    if (configOutEl) configOutEl.textContent = '';
    return httpJson('/setup/api/config/raw').then(function (j) {
      if (configPathEl) {
        configPathEl.textContent = (j.path || '(unknown)') + (j.exists ? '' : ' (not created yet)');
      }
      configTextEl.value = j.content || '';
    }).catch(function (e) {
      if (configOutEl) configOutEl.textContent = 'Error: ' + String(e);
    });
  }

  function saveConfigRaw() {
    if (!configTextEl) return;
    if (!confirm('Save config and restart gateway?')) return;
    if (configOutEl) configOutEl.textContent = 'Saving...\n';
    return httpJson('/setup/api/config/raw', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: configTextEl.value })
    }).then(function (j) {
      if (configOutEl) configOutEl.textContent = 'Saved. Gateway restarted.\n';
      return refreshStatus();
    }).catch(function (e) {
      if (configOutEl) configOutEl.textContent += '\nError: ' + String(e) + '\n';
    });
  }

  if (configReloadEl) configReloadEl.onclick = loadConfigRaw;
  if (configSaveEl) configSaveEl.onclick = saveConfigRaw;

  // Initialize
  refreshStatus();

})();
