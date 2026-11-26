/* QwickWatch Edge OS portal — real on-device backends.
   Every loader below reuses the exact CGI path and field names of the stock
   Thingino page for that setting. Endpoints absent from a given build are
   reported honestly instead of showing invented data. */
(function () {
  "use strict";

  var $ = function (id) { return document.getElementById(id); };
  var loaded = {};
  var store = {};              // cached GET payloads, merged into POSTs
  var panel = "live";

  function bool(v) { return v === true || v === "true" || v === 1 || v === "1"; }

  function say(id, msg, bad) {
    var el = $(id);
    if (!el) return;
    el.textContent = msg;
    el.className = bad ? "err" : (msg ? "okmsg" : "status-line");
  }

  async function api(path, options) {
    var opts = options || {};
    var form = !!opts.form;
    var response = await fetch(path, {
      method: opts.method || "GET",
      headers: opts.body
        ? Object.assign(
            {
              "Content-Type": form
                ? "application/x-www-form-urlencoded"
                : "application/json",
            },
            opts.headers || {}
          )
        : Object.assign({ Accept: "application/json" }, opts.headers || {}),
      body: opts.body
        ? form
          ? new URLSearchParams(opts.body).toString()
          : JSON.stringify(opts.body)
        : undefined,
      cache: "no-store",
    });
    var text = await response.text();
    var data = {};
    try { data = text ? JSON.parse(text) : {}; } catch (e) { data = {}; }
    if (!response.ok || (data && data.error)) {
      var m = data && data.error && data.error.message
        ? data.error.message
        : "HTTP " + response.status;
      throw new Error(m);
    }
    return data;
  }

  function markUnavailable(noteId, what) {
    say(noteId, what + " is not available in this firmware build (endpoint missing).", true);
  }

  function clampPct(value) {
    var n = Number(value);
    return isFinite(n) ? Math.max(0, Math.min(100, Math.round(n))) : 0;
  }

  // Streamer settings (privacy, mic gain) are not plain config files. They are
  // served by the local agent and reached through the camera's own CGI proxy.
  var apiKeyPromise;
  function agentKey() {
    if (!apiKeyPromise) {
      apiKeyPromise = api("/x/api-key.cgi")
        .then(function (k) { return (k && k.exists && k.api_key) || ""; })
        .catch(function () { return ""; });
    }
    return apiKeyPromise;
  }

  async function agentApi(path, options) {
    var opts = options || {};
    var key = await agentKey();
    var headers = Object.assign({ Accept: "application/json" }, opts.headers || {});
    var body;
    if (opts.body !== undefined) {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(opts.body);
    }
    if (key) headers["X-API-Key"] = key;
    var response = await fetch("/x/agent.cgi?agent_path=" + encodeURIComponent(path), {
      method: opts.method || "GET",
      headers: headers,
      body: body,
      cache: "no-store",
    });
    var text = await response.text();
    var data = {};
    try { data = text ? JSON.parse(text) : {}; } catch (e) { data = {}; }
    if (!response.ok || (data && data.error)) {
      var m = data && data.error && data.error.message
        ? data.error.message
        : "HTTP " + response.status;
      throw new Error(m);
    }
    return data;
  }

  function b64text(raw) {
    if (typeof raw !== "string" || !raw) return "";
    try {
      var bin = atob(raw.replace(/\s+/g, ""));
      if (typeof TextDecoder === "undefined") return bin;
      var bytes = new Uint8Array(bin.length);
      for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      return new TextDecoder().decode(bytes);
    } catch (e) {
      return "";
    }
  }

  function firstMatchLine(text, re) {
    var lines = String(text || "").split("\n");
    for (var i = 0; i < lines.length; i++) {
      if (re.test(lines[i])) return lines[i].trim();
    }
    return "";
  }

  function humanBytes(value) {
    var n = Number(value);
    if (!isFinite(n) || n <= 0) return "—";
    var units = ["B", "KB", "MB", "GB", "TB"];
    var i = 0;
    while (n >= 1024 && i < units.length - 1) {
      n /= 1024;
      i++;
    }
    return (i === 0 ? n : n.toFixed(n >= 100 ? 0 : n >= 10 ? 1 : 2)) + " " + units[i];
  }

  function commandOutput(payload, index) {
    var commands = (payload && payload.commands) || [];
    return b64text((commands[index || 0] || {}).output_base64);
  }

  async function flashMetadata() {
    if (store.flash) return store.flash;
    var d = await api("/x/tool-upgrade.cgi");
    store.flash = (d && d.data) || d || {};
    return store.flash;
  }

  function segBind(wrap, cb) {
    if (!wrap) return;
    wrap.querySelectorAll("button").forEach(function (b) {
      b.addEventListener("click", function () {
        wrap.querySelectorAll("button").forEach(function (x) { x.classList.remove("active"); });
        b.classList.add("active");
        cb(b.dataset.value);
      });
    });
  }
  function segGet(wrap, fallback) {
    var b = wrap && wrap.querySelector("button.active");
    return b ? b.dataset.value : fallback;
  }
  function segSet(wrap, value) {
    if (!wrap) return;
    wrap.querySelectorAll("button").forEach(function (b) {
      b.classList.toggle("active", b.dataset.value === value);
    });
  }

  /* ---------------- global tab switching (same semantics as mockup) ------- */
  window.showTab = function (id, el) {
    document.querySelectorAll(".tabpanel").forEach(function (p) { p.classList.remove("active"); });
    var target = $("tab-" + id);
    if (target) target.classList.add("active");
    document.querySelectorAll(".navitem").forEach(function (n) { n.classList.remove("active"); });
    if (el) el.classList.add("active");
    else {
      var nav = document.querySelector('.navitem[data-tab="' + id + '"]');
      if (nav) nav.classList.add("active");
    }
    panel = id;
    var loader = loaders[id];
    if (loader && !loaded[id]) {
      loaded[id] = true;
      Promise.resolve(loader.load()).catch(function (e) { say("saveNote", e.message, true); });
    }
  };

  /* ---------------- device name -> real Admin profile CGI ---------------- */
  window.renameDevice = async function () {
    var input = $("deviceName");
    if (!input || !input.value.trim()) return;
    try {
      var cfg = await api("/x/json-config-admin.cgi");
      var payload = {
        name: input.value.trim(),
        email: cfg.email || "",
        telegram: cfg.telegram || "",
        discord: cfg.discord || "",
      };
      await api("/x/json-config-admin.cgi", { method: "POST", body: payload });
      var b = $("deviceMeta");
      if (b) b.textContent = "online · " + (b.dataset.ip || "name saved");
      setTimeout(function () {
        var n = $("saveNote"); if (n) n.textContent = "";
      }, 3000);
    } catch (e) {
      say("deviceMeta", "rename failed: " + e.message, true);
    }
  };

  /* ---------------- shared boot: session + network identity -------------- */
  async function bootIdentity() {
    try {
      var s = await api("/x/session-status.cgi");
      if (s.username) $("accountUser").value = s.username;
      if (s.authenticated === false) {
        $("onlineBadge").textContent = "● session expired — reload";
        $("onlineBadge").className = "badge warn";
      }
    } catch (e) { /* endpoints may be proxied differently */ }

    try {
      var n = await api("/x/json-config-network.cgi");
      store.network = n;
      if (n.hostname) $("deviceName").value = n.hostname.replace(/\.(local|lan)$/i, "");
      var ifaces = (n.interfaces && [n.interfaces.eth0, n.interfaces.wlan0, n.interfaces.usb0]) || [];
      var ip = "";
      for (var i = 0; i < ifaces.length; i++) {
        if (ifaces[i] && ifaces[i].address) { ip = ifaces[i].address; break; }
      }
      var meta = $("deviceMeta");
      if (meta) { meta.dataset.ip = ip; meta.textContent = "online · " + (ip || "IP not configured"); }
      return n;
    } catch (e) { /* handled by the network loader */ }
  }

  /* ---------------- panel loaders / savers ------------------------------- */
  var loaders = {};

  loaders.live = {
    load: async function () {
      var img = $("liveStream");
      var placeholder = $("camPlaceholder");
      if (img) {
        img.addEventListener("load", function () {
          img.style.display = "block";
          if (placeholder) placeholder.style.display = "none";
        }, { once: true });
        img.src = "/x/ch0.mjpg?" + Date.now();
      }
      var started = Date.now();
      setInterval(function () {
        var s = Math.floor((Date.now() - started) / 1000);
        var c = $("liveClock");
        if (c) c.textContent = "00:" + String(Math.floor(s / 60)).padStart(2, "0") + ":" + String(s % 60).padStart(2, "0");
      }, 1000);

      // motion sensitivity + speaker mirror the real Send2 config
      try {
        var d = await api("/x/json-send2.cgi");
        store.send2 = d;
        var motion = (d && d.motion) || {};
        if (motion.sensitivity != null) {
          var pct = Math.max(0, Math.min(100, Math.round((Number(motion.sensitivity) - 1) * 100 / 9)));
          $("liveMotion").value = pct;
        }
      } catch (e) { /* optional build */ }

      // GPIO IR brightness, when the GPIO config endpoint exists
      try {
        var g = await api("/x/json-config-gpio.cgi");
        store.gpio = g;
        var ir = (g && g.ir && g.ir.brightness) != null ? g.ir.brightness : (g && g.ir_led);
        if (ir != null) $("liveIr").value = Number(ir);
      } catch (e) { /* optional package */ }

      // day/night mode for the live quick control
      try {
        var dn = await api("/x/json-config-daynight.cgi");
        store.daynight = dn;
        var mode = dn && (dn.mode || (dn.daynight && dn.daynight.mode));
        if (mode) segSet($("liveNightSeg"), String(mode).toLowerCase());
      } catch (e) { /* optional package */ }

      try {
        var u = await api("/x/json-system-usage.cgi");
        var d = (u && u.data) || u || {};
        if (d.memory) {
          var mb = function (kb) { return Math.round(Number(kb || 0) / 1024); };
          $("healthRam").textContent = mb(d.memory.free) + " MB / " + mb(d.memory.total) + " MB";
        }
        if (d.overlay) $("healthNote").textContent = "Overlay: " + d.overlay.used + " / " + d.overlay.total + " KB used · values from json-system-usage.cgi";
      } catch (e) { say("healthNote", "Health stats unavailable: " + e.message, true); }

      try {
        var h = await api("/x/json-heartbeat-slow.cgi");
        if (h && h.uptime) $("healthUptime").textContent = h.uptime;
        if (h && h.temperature) $("healthTemp").textContent = h.temperature + "°C";
        if (h && h.wifi && h.wifi.rssi != null) $("healthRssi").textContent = h.wifi.rssi + " dBm";
        if (h && h.wifi_rssi != null) $("healthRssi").textContent = h.wifi_rssi + " dBm";
      } catch (e) { $("healthNote").textContent = "Heartbeat not running on this build."; }
    },
    save: async function () {
      var payloads = [];
      if (store.send2) {
        var d = JSON.parse(JSON.stringify(store.send2));
        d.motion = d.motion || {};
        d.motion.sensitivity = Math.max(1, Math.min(10, Math.round(Number($("liveMotion").value) * 9 / 100) + 1));
        payloads.push(["/x/json-send2.cgi", d]);
      }
      for (var i = 0; i < payloads.length; i++) await api(payloads[i][0], { method: "POST", body: payloads[i][1] });
      return "Live quick settings saved.";
    },
  };

  loaders.picture = {
    load: async function () {
      var band = "off";
      try {
        var d = await api("/x/json-config-daynight.cgi");
        store.daynight = d;
        var cfg = (d && d.daynight) || d || {};
        var mode = String(cfg.force_mode || "").toLowerCase();
        segSet($("picNightSeg"), mode === "day" || mode === "night" ? mode : "auto");
        if (cfg.night_threshold != null) {
          var pct = clampPct(cfg.night_threshold);
          $("picThreshold").value = pct;
          $("picThreshVal").textContent = pct;
        }
        var c = cfg.controls || {};
        band = c.ir850 && !c.ir940 ? "ir850" : !c.ir850 && c.ir940 ? "ir940" : "off";
        $("picIrBand").value = band;
      } catch (e) {
        say("picNote", "Day/night endpoint is not available in this build.", true);
      }

      // Sunrise/sunset scheduling is the real dusk/dawn control on this device.
      try {
        var s = await api("/x/json-daynight-sun.cgi");
        store.sun = s;
        var sun = (s && s.sun) || s || {};
        if (sun.enabled != null) $("picDusk").checked = bool(sun.enabled);
      } catch (e) {
        $("picDusk").disabled = true;
      }

      try {
        var g = await api("/x/json-config-gpio.cgi");
        store.gpio = g;
        var gpio = (g && g.gpio) || {};
        var led = (g && g.led) || {};
        if (led.startup_indicator) $("picStatusLed").value = led.startup_indicator;
        var pin = gpio[band];
        if (pin && pin.pwm_level != null) $("picIr").value = clampPct(pin.pwm_level);
        else if (band !== "off") $("picIr").disabled = true;
      } catch (e) { /* GPIO package absent */ }

      // Privacy is streamer state, reached through the agent CGI proxy.
      try {
        var p = await agentApi("/api/v1/config/privacy");
        store.privacyAgent = true;
        var pv = (p && p.privacy) || p || {};
        if (pv.enabled != null) $("picPrivacy").checked = bool(pv.enabled);
      } catch (e) {
        $("picPrivacy").disabled = true;
      }
    },
    save: async function () {
      var msgs = [];
      var band = $("picIrBand").value;
      if (store.daynight) {
        var d = JSON.parse(JSON.stringify(store.daynight));
        var cfg = d.daynight || d;
        var mode = segGet($("picNightSeg"), "auto");
        cfg.force_mode = mode === "auto" ? "" : mode;
        var th = clampPct($("picThreshold").value);
        cfg.night_threshold = th;
        var day = Number(cfg.day_threshold);
        if (!isFinite(day) || day <= th) cfg.day_threshold = Math.min(100, th + 25);
        cfg.controls = cfg.controls || {};
        cfg.controls.ir850 = band === "ir850";
        cfg.controls.ir940 = band === "ir940";
        await api("/x/json-config-daynight.cgi", {
          method: "POST",
          body: d.daynight ? d : { daynight: cfg },
        });
        msgs.push("day/night");
      }
      if (store.sun) {
        var s = JSON.parse(JSON.stringify(store.sun));
        var sun = s.sun || s;
        sun.enabled = $("picDusk").checked;
        await api("/x/json-daynight-sun.cgi", {
          method: "POST",
          body: s.sun ? s : { sun: sun },
        });
        msgs.push("sun schedule");
      }
      if (store.gpio) {
        var g = JSON.parse(JSON.stringify(store.gpio));
        var gpio = g.gpio || {};
        var payload = { startup_indicator: $("picStatusLed").value };
        ["ir850", "ir940", "white"].forEach(function (name) {
          var p = gpio[name] || {};
          if (p.pin == null || p.pin === "") return;
          var out = { pin: p.pin, inv: !!p.active_low, lit: !!p.active_on_boot };
          if (p.pwm_channel != null) out.ch = p.pwm_channel;
          if (p.pwm_level != null) out.lvl = p.pwm_level;
          if (name === band && !$("picIr").disabled) out.lvl = clampPct($("picIr").value);
          payload[name] = out;
        });
        await api("/x/json-config-gpio.cgi", { method: "POST", body: payload });
        msgs.push("GPIO");
      }
      if (store.privacyAgent) {
        try {
          await agentApi("/api/v1/actions/privacy", {
            method: "POST",
            body: { enabled: $("picPrivacy").checked },
          });
          msgs.push("privacy");
        } catch (e) { /* streamer agent absent */ }
      }
      return msgs.length ? "Saved " + msgs.join(", ") + "." : "No picture backend available in this build.";
    },
  };

  loaders.audio = {
    load: async function () {
      try {
        var d = await api("/x/json-send2.cgi");
        store.send2 = d;
        var spk = (d && d.speaker) || {};
        if (spk.volume != null) $("audioSpeaker").value = clampPct(spk.volume);
      } catch (e) {
        markUnavailable("audioNote", "Speaker config");
      }
      try {
        var m = await agentApi("/api/v1/settings/audio/mic-gain");
        store.micAgent = true;
        var gain = m && (m.mic_gain != null ? m.mic_gain : m.gain);
        if (gain != null) $("audioMic").value = clampPct(Number(gain) * 100 / 31);
      } catch (e) {
        $("audioMic").disabled = true;
      }
    },
    save: async function () {
      var msgs = [];
      if (store.send2) {
        var d = JSON.parse(JSON.stringify(store.send2));
        d.speaker = d.speaker || {};
        d.speaker.volume = clampPct($("audioSpeaker").value);
        await api("/x/json-send2.cgi", { method: "POST", body: { speaker: d.speaker } });
        msgs.push("speaker");
      }
      if (store.micAgent) {
        var gain = Math.round(clampPct($("audioMic").value) * 31 / 100);
        await agentApi("/api/v1/settings/audio/mic-gain", {
          method: "PATCH",
          body: { mic_gain: gain },
        });
        msgs.push("microphone");
      }
      if (!msgs.length) throw new Error("Audio endpoints are not available in this build.");
      return "Saved " + msgs.join(" and ") + ".";
    },
  };

  loaders.netaccess = {
    load: async function () {
      var n = store.network || await api("/x/json-config-network.cgi");
      store.network = n;
      var eth = (n.interfaces && n.interfaces.eth0) || {};
      var wlan = (n.interfaces && n.interfaces.wlan0) || {};
      var active = bool(eth.link_up) ? eth : bool(wlan.link_up) ? wlan : (eth.address ? eth : wlan);
      var address = eth.address || wlan.address || "";

      $("netHostname").textContent = n.hostname || "—";
      $("netSsid").value = (n.wifi && n.wifi.ssid) || "";
      if ($("netWifiPassword")) $("netWifiPassword").value = "";
      $("netDhcp").checked = eth.dhcp == null ? true : bool(eth.dhcp);
      $("netAddress").textContent = address || "—";
      $("netGateway").textContent = active.gateway || "—";
      $("netWifiEnabled").checked = bool(n.wifi_ap && n.wifi_ap.enabled);
      $("netStatus").textContent = bool(active.link_up)
        ? "Link up · " + (bool(active.dhcp) ? "DHCP" : "static")
        : address ? "Configured · link down" : "Not configured";
      $("netRtsp").textContent = "rtsp://" + (address || location.hostname) + ":554/ch0";

      try {
        var w = await api("/x/json-config-webui.cgi");
        store.webui = w;
        $("netRange").value = w.auth_bypass_ips || "";
      } catch (e) {
        $("netRange").disabled = true;
        say("netNote", "Web UI access restrictions are not available in this build.", true);
      }

      try {
        var wg = await api("/x/json-config-wireguard.cgi");
        store.wg = wg;
        $("netVpn").checked = bool(wg.enabled);
        if (wg.wg_supported === false) {
          $("netVpn").disabled = true;
          say("netNote", "WireGuard tooling is not installed in this build.");
        }
      } catch (e) {
        $("netVpn").disabled = true;
      }
    },
    save: async function () {
      var n = JSON.parse(JSON.stringify(store.network || {}));
      if (!n.hostname) throw new Error("Network settings did not load; reload the page.");
      if (!(n.dns && (n.dns.primary || n.dns.secondary))) {
        throw new Error("No DNS server is configured on this camera; set one in the stock Network page first.");
      }

      n.wifi = n.wifi || {};
      var ssid = $("netSsid").value.trim();
      var pass = $("netWifiPassword") ? $("netWifiPassword").value : "";
      var previousSsid = (store.network.wifi && store.network.wifi.ssid) || "";
      if (ssid && ssid !== previousSsid && !pass) {
        throw new Error("Enter the Wi-Fi password for the new network before saving.");
      }
      n.wifi.ssid = ssid;
      n.wifi.password = pass;
      if (n.wifi.bssid == null) n.wifi.bssid = "";

      n.interfaces = n.interfaces || {};
      var eth = n.interfaces.eth0 || {};
      eth.dhcp = $("netDhcp").checked;
      n.interfaces.eth0 = eth;
      n.wifi_ap = n.wifi_ap || {};
      n.wifi_ap.enabled = $("netWifiEnabled").checked;

      await api("/x/json-config-network.cgi", { method: "POST", body: n });
      store.network.wifi = store.network.wifi || {};
      store.network.wifi.ssid = ssid;
      if (pass) $("netWifiPassword").value = "";

      if (store.webui) {
        var w = JSON.parse(JSON.stringify(store.webui));
        var range = $("netRange").value.trim();
        if (range !== (store.webui.auth_bypass_ips || "")) {
          w.theme = ["light", "dark", "auto"].indexOf(w.theme) >= 0 ? w.theme : "auto";
          w.paranoid = bool(w.paranoid);
          w.track_focus = w.track_focus == null ? false : bool(w.track_focus);
          w.focus_timeout = Number(w.focus_timeout) || 0;
          w.auth_bypass_ips = range;
          await api("/x/json-config-webui.cgi", { method: "POST", body: w });
          store.webui = w;
        }
      }

      if (store.wg && !$("netVpn").disabled) {
        var wg = JSON.parse(JSON.stringify(store.wg));
        wg.enabled = $("netVpn").checked;
        delete wg.action;
        await api("/x/json-config-wireguard.cgi", { method: "POST", body: wg });
        store.wg.enabled = wg.enabled;
      }
      return "Network settings saved (a reboot may be required).";
    },
  };

  loaders.notify = {
    load: async function () {
      var notes = [];
      try {
        var d = await api("/x/json-config-send2.cgi");
        store.notifyConfig = d;
        var motion = d.motion || {};
        document.querySelectorAll("#notifyServices [data-service]").forEach(function (row) {
          var input = row.querySelector("input");
          var key = "send2" + row.dataset.service;
          input.checked = bool(motion[key]);
          input.disabled = false;
          row.dataset.realKey = key;
        });
        var mqtt = (d.config && d.config.mqtt) || {};
        $("notifyMqtt").checked = bool(motion.send2mqtt);
        $("mqttHost").value = mqtt.host || "";
        $("mqttTopic").value = mqtt.topic || "";
        if (d.meta && d.meta.mqtt_available === false) {
          $("notifyMqtt").disabled = true;
          notes.push("MQTT publisher is not installed in this build.");
        }
      } catch (e) {
        document.querySelectorAll("#notifyServices input").forEach(function (input) {
          input.disabled = true;
        });
        $("notifyMqtt").disabled = true;
        notes.push("Send2 notification config is not available in this build.");
      }

      try {
        var ha = await api("/x/json-config-ha.cgi");
        store.ha = ha;
        $("notifyHa").checked = bool(ha.enabled);
      } catch (e) {
        $("notifyHa").disabled = true;
        notes.push("Home Assistant integration is not installed in this build.");
      }
      say("notifyNote", notes.join(" "), notes.length > 0);
    },
    save: async function () {
      if (!store.notifyConfig) throw new Error("Notification settings did not load; reload the page.");

      var haPayload = null;
      if (store.ha && !$("notifyHa").disabled) {
        var ha = JSON.parse(JSON.stringify(store.ha));
        var enabling = $("notifyHa").checked && !bool(ha.enabled);
        if (enabling && !(ha.mqtt && ha.mqtt.host)) {
          throw new Error("Set the Home Assistant MQTT broker on the Home Assistant page first.");
        }
        ha.enabled = $("notifyHa").checked;
        haPayload = ha;
      }

      var d = JSON.parse(JSON.stringify(store.notifyConfig));
      var motion = d.motion || {};
      document.querySelectorAll("#notifyServices [data-service]").forEach(function (row) {
        var input = row.querySelector("input");
        if (!input.disabled) motion[row.dataset.realKey] = input.checked;
      });
      if (!$("notifyMqtt").disabled) motion.send2mqtt = $("notifyMqtt").checked;

      var cfg = JSON.parse(JSON.stringify(d.config || {}));
      cfg.mqtt = cfg.mqtt || {};
      cfg.mqtt.host = $("mqttHost").value.trim();
      cfg.mqtt.topic = $("mqttTopic").value.trim();
      await api("/x/json-config-send2.cgi", {
        method: "POST",
        body: { config: cfg, motion: motion },
      });
      store.notifyConfig.config = cfg;
      store.notifyConfig.motion = motion;

      var saved = ["notification destinations"];
      if (haPayload) {
        await api("/x/json-config-ha.cgi", { method: "POST", body: haPayload });
        store.ha = haPayload;
        saved.push("Home Assistant");
      }
      return "Saved " + saved.join(" and ") + ".";
    },
  };

  loaders.account = {
    load: async function () {
      try {
        var w = await api("/x/json-config-webui.cgi");
        store.webui = w;
        if (w.auth_bypass_ips) $("netRange").value = w.auth_bypass_ips;
      } catch (e) { /* optional */ }
      try {
        var t = await api("/x/json-config-time.cgi");
        store.time = t;
        if (t.tz_name) {
          var input = $("accountTz");
          if (input && input.tagName === "SELECT") {
            var o = document.createElement("option");
            o.value = t.tz_name;
            o.textContent = t.tz_name + " (current)";
            input.appendChild(o);
          }
          if (input) input.value = t.tz_name;
        }
        $("accountNtp").value = t.ntp_server_0 || "";
      } catch (e) { markUnavailable("accountNote", "Time config"); }
      try {
        var zones = await api("/a/tz.json");
        var list = $("accountTzList");
        if (list && Array.isArray(zones)) {
          zones.forEach(function (z) {
            if (!z || !z.n) return;
            var option = document.createElement("option");
            option.value = z.n;
            list.appendChild(option);
          });
        }
      } catch (e) { /* timezone table absent in this build */ }
    },
    save: async function () {
      var msgs = [];
      var pass = $("accountPass").value;
      if (pass) {
        if (!confirm("Change the root password for this camera? You will need the new password at next sign-in.")) {
          throw new Error("Password change cancelled.");
        }
        var w = JSON.parse(JSON.stringify(store.webui || {}));
        w.theme = w.theme || "auto";
        w.paranoid = w.paranoid == null ? false : w.paranoid;
        w.track_focus = w.track_focus == null ? true : w.track_focus;
        w.focus_timeout = w.focus_timeout || 0;
        w.auth_bypass_ips = w.auth_bypass_ips || "";
        w.password = pass;
        await api("/x/json-config-webui.cgi", { method: "POST", body: w });
        $("accountPass").value = "";
        msgs.push("password");
      }
      if (store.time) {
        var t = JSON.parse(JSON.stringify(store.time));
        t.action = "update";
        if ($("accountTz").value) t.tz_name = $("accountTz").value;
        if ($("accountNtp").value.trim()) t.ntp_server_0 = $("accountNtp").value.trim();
        await api("/x/json-config-time.cgi", { method: "POST", body: t });
        msgs.push("time");
      }
      return msgs.length ? "Saved " + msgs.join(" and ") + "." : "Sign-in fields unchanged.";
    },
  };

  loaders.firmware = {
    load: async function () {
      try {
        var release = await api("/x/info.cgi?release");
        var os = {};
        commandOutput(release, 0)
          .split("\n")
          .forEach(function (line) {
            var m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
            if (!m) return;
            try { os[m[1]] = JSON.parse(m[2]); } catch (e) { os[m[1]] = m[2]; }
          });
        $("fwVersion").textContent =
          os.PRETTY_NAME || os.VERSION_ID || os.NAME || "not reported";
        $("fwBuild").textContent =
          os.BUILD_ID || os.VERSION_ID || "not reported by firmware";
      } catch (e) {
        $("fwVersion").textContent = "unavailable";
        $("fwBuild").textContent = "unavailable";
      }
      try {
        var dmesg = await api("/x/info.cgi?dmesg");
        var line = firstMatchLine(commandOutput(dmesg, 0), /Linux version/i);
        $("fwKernel").textContent = line ? line.slice(0, 120) : "not reported";
      } catch (e) {
        $("fwKernel").textContent = "unavailable";
      }
      try {
        var f = await flashMetadata();
        var opts = (f.ota && f.ota.options) || [];
        var sel = $("fwOtaMode");
        if (sel) {
          sel.innerHTML = "";
          opts.forEach(function (o) {
            var option = document.createElement("option");
            option.value = o.id;
            option.textContent = o.label || o.id;
            option.title = o.description || "";
            sel.appendChild(option);
          });
          sel.disabled = opts.length === 0;
        }
        var prepare = $("fwPrepareOta");
        if (prepare) prepare.disabled = opts.length === 0;
        if (f.ota && f.ota.notes) say("fwNote", f.ota.notes);
      } catch (e) {
        markUnavailable("fwNote", "Flash operations metadata");
        var s = $("fwOtaMode"); if (s) s.disabled = true;
        var b = $("fwPrepareOta"); if (b) b.disabled = true;
      }
    },
    save: async function () {
      return "Firmware has no editable settings here; use Flash operations to upgrade.";
    },
  };

  loaders.storage = {
    load: async function () {
      try {
        var d = await api("/x/tool-sdcard.cgi");
        var dev = d.device || null;
        if (bool(d.has_sdcard) && dev) {
          var label = [dev.vendor, dev.model]
            .filter(function (x) { return !!x; })
            .join(" ")
            .trim();
          $("sdCard").textContent = label || dev.name || dev.node || "SD card";
          $("sdCapacity").textContent =
            Number(dev.size_bytes) > 0
              ? humanBytes(dev.size_bytes)
              : "size not reported";
          var mounts = b64text(d.reports && d.reports.mounts_b64)
            .split("\n")
            .filter(function (line) { return /^\/dev\/mmc/.test(line); });
          var mount = mounts.length ? mounts[0].split(/\s+/)[1] : "";
          $("sdMount").textContent =
            mount || (dev.node ? dev.node + " (not mounted)" : "not mounted");
          $("sdStatus").textContent = mount ? "Mounted" : "Detected, not mounted";
          $("sdDevice").textContent = dev.node || "—";
        } else {
          $("sdCard").textContent = "No SD card detected";
          $("sdCapacity").textContent = "—";
          $("sdMount").textContent = "—";
          $("sdStatus").textContent = "No card present";
          $("sdDevice").textContent = "—";
        }
      } catch (e) {
        $("sdCard").textContent = "SD card tool unavailable";
        $("sdCapacity").textContent = "—";
        $("sdMount").textContent = "—";
        $("sdStatus").textContent = "unavailable";
        $("sdDevice").textContent = "—";
      }
      try {
        var f = await flashMetadata();
        var backup = f.backup || {};
        var button = $("sdBackup");
        if (button) {
          button.disabled = !backup.download_url;
          if (backup.download_url) {
            say(
              "backupNote",
              "Archive: " + (backup.filename || "backup.tar.gz") +
                " — contains Wi-Fi credentials and service accounts; store securely."
            );
          } else {
            markUnavailable("backupNote", "Configuration backup");
          }
        }
      } catch (e) {
        var b = $("sdBackup"); if (b) b.disabled = true;
        markUnavailable("backupNote", "Configuration backup");
      }
    },
  };

  loaders.syslog = {
    load: async function () {
      try {
        var d = await api("/x/json-config-syslog.cgi");
        store.syslog = d;
        $("syslogHost").value = (d.host || "").replace(/^"|"$/g, "");
        $("syslogPort").value = d.port || "514";
        $("syslogEnabled").checked = bool(d.enabled);
        $("syslogFile").checked = bool(d.file);
        say("syslogNote", "Loaded from /x/json-config-syslog.cgi.");
      } catch (e) { markUnavailable("syslogNote", "Remote logging config"); }
    },
    save: async function () {
      await api("/x/json-config-syslog.cgi", { method: "POST", body: {
        host: $("syslogHost").value.trim(),
        port: $("syslogPort").value.trim() || "514",
        enabled: $("syslogEnabled").checked,
        file: $("syslogFile").checked,
      } });
      return "Remote logging settings saved.";
    },
  };

  loaders.wgkeys = {
    load: async function () {
      try {
        var d = await api("/x/json-config-wireguard.cgi");
        store.wg = d;
        if (d.privkey) $("wgPriv").value = d.privkey;
        if (d.localpub) $("wgPub").value = d.localpub;
        say("wgNote", "Loaded from /x/json-config-wireguard.cgi.");
      } catch (e) { markUnavailable("wgNote", "WireGuard config"); }
    },
  };

  /* panels that are pure links to real on-device tools need no loader */
  ["zones", "voice", "detection", "info", "filemanager", "nettest", "streamer", "advanced"].forEach(function (id) {
    loaders[id] = { load: function () {} };
  });

  /* ---------------- top bar actions ------------------------------------- */
  $("rebootBtn").addEventListener("click", function () {
    if (!confirm("Reboot this camera now? The web UI will be unavailable for a moment.")) return;
    api("/x/reboot.cgi", { method: "POST", body: {} })
      .catch(function () { /* CGI may reply with a redirect/empty body */ })
      .finally(function () { location.reload(); });
  });

  $("saveBtn").addEventListener("click", async function () {
    var btn = $("saveBtn");
    var loader = loaders[panel];
    if (!loader || !loader.save) {
      alert("This panel has no on-device settings to save.");
      return;
    }
    btn.disabled = true;
    try {
      var msg = await loader.save();
      var note = $("saveNote") || $("picNote") || $("syslogNote") || $("netNote") || $("notifyNote");
      if (note) { note.textContent = msg; note.className = "okmsg"; }
      setTimeout(function () { if (note) note.textContent = ""; }, 5000);
    } catch (e) {
      var n = $("saveNote") || $("picNote") || $("syslogNote") || $("netNote") || $("notifyNote");
      if (n) { n.textContent = "Save failed: " + e.message; n.className = "err"; }
      else alert("Save failed: " + e.message);
    } finally { btn.disabled = false; }
  });

  $("netUseCurrent").addEventListener("click", function () {
    var n = store.network || {};
    var ifaces = (n.interfaces && [n.interfaces.eth0, n.interfaces.wlan0, n.interfaces.usb0]) || [];
    var ip = "";
    for (var i = 0; i < ifaces.length; i++) {
      if (ifaces[i] && ifaces[i].address) { ip = ifaces[i].address; break; }
    }
    var m = ip.match(/^(\d+\.\d+\.\d+)\.\d+$/);
    if (m) {
      $("netRange").value = m[1] + ".0/24";
      say("netNote", "");
    } else {
      say("netNote", "Camera has no IPv4 address yet; enter the allowed range manually.", true);
    }
  });

  async function wgAction(action) {
    try {
      var d = await api("/x/json-config-wireguard.cgi", { method: "POST", body: { action: action } });
      var result = (d && d.data) || d || {};
      if (action === "generate_keypair") {
        $("wgPriv").value = result.privkey || "";
        $("wgPub").value = result.localpub || "";
      }
      say("wgNote", action === "generate_keypair" ? "Key pair generated on-device." : "Pre-shared key generated on-device.");
    } catch (e) { say("wgNote", "Key generation failed: " + e.message, true); }
  }
  $("wgGenPair").addEventListener("click", function () { wgAction("generate_keypair"); });
  $("wgGenPsk").addEventListener("click", function () { wgAction("generate_psk"); });

  $("fwPrepareOta").addEventListener("click", async function () {
    var sel = $("fwOtaMode");
    if (!sel || !sel.value) {
      say("fwNote", "No update option is exposed by this firmware build.", true);
      return;
    }
    var label = sel.options[sel.selectedIndex].textContent;
    if (!confirm("Prepare a " + label + " upgrade command? Nothing is flashed until you run it from Flash operations.")) return;
    try {
      var d = await api("/x/tool-upgrade.cgi", {
        method: "POST",
        form: true,
        body: { action: "ota", option: sel.value },
      });
      $("fwOtaCommand").value = d.command || "No command returned by the camera.";
      say("fwNote", "Command prepared. Flash operations runs it and reboots the camera; this panel does not flash.");
    } catch (e) {
      say("fwNote", "Could not prepare upgrade: " + e.message, true);
    }
  });

  $("sdBackup").addEventListener("click", function () {
    var backup = store.flash && store.flash.backup;
    if (backup && backup.download_url) window.location.href = backup.download_url;
  });

  $("factoryResetBtn").addEventListener("click", function () {
    // Preserve the stock page's destructive-action confirmation.
    if (!confirm("Factory reset will erase configuration on this camera. Continue?")) return;
    if (!confirm("This cannot be undone. Type-free confirmation: are you certain?")) return;
    api("/x/firmware-reset.cgi", { method: "POST", body: { action: "factory_reset" } })
      .then(function () { say("resetNote", "Factory reset command accepted by the device."); })
      .catch(function (e) { say("resetNote", "Factory reset failed: " + e.message, true); });
  });

  /* ---------------- boot ------------------------------------------------- */
  bootIdentity().then(function () {
    return loaders.live.load().catch(function (e) { say("healthNote", e.message, true); });
  });
  loaded.live = true;
})();
