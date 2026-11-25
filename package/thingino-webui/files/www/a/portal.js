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
    var response = await fetch(path, {
      method: opts.method || "GET",
      headers: opts.body
        ? Object.assign({ "Content-Type": "application/json" }, opts.headers || {})
        : Object.assign({ Accept: "application/json" }, opts.headers || {}),
      body: opts.body ? JSON.stringify(opts.body) : undefined,
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
      try {
        var d = await api("/x/json-config-daynight.cgi");
        store.daynight = d;
        var cfg = (d && d.daynight) || d || {};
        if (cfg.mode) segSet($("picNightSeg"), String(cfg.mode).replace(/^auto$/, "auto"));
        if (cfg.threshold != null) { $("picThreshold").value = cfg.threshold; $("picThreshVal").textContent = cfg.threshold; }
        if (cfg.dusk2dawn != null) $("picDusk").checked = bool(cfg.dusk2dawn);
      } catch (e) {
        say("picNote", "Day/night config endpoint not present in this build.", true);
      }
      try {
        var g = await api("/x/json-config-gpio.cgi");
        store.gpio = g;
        var gc = (g && g.gpio) || g || {};
        if (gc.ir_brightness != null) $("picIr").value = Number(gc.ir_brightness);
        if (gc.ir_led != null) $("picIrBand").value = bool(gc.ir_led) ? "ir850" : "off";
        if (gc.status_led != null) $("picStatusLed").value = String(gc.status_led).toLowerCase();
      } catch (e) { /* optional */ }

      // Privacy lives in the streamer config (real endpoint: json-prudynt.cgi)
      try {
        var p = await api("/x/json-prudynt.cgi", { method: "POST", body: { privacy: { enabled: null } } });
        if (p && p.privacy && p.privacy.enabled != null) $("picPrivacy").checked = bool(p.privacy.enabled);
      } catch (e) { /* streamer absent */ }
    },
    save: async function () {
      var msgs = [];
      if (store.daynight) {
        var d = JSON.parse(JSON.stringify(store.daynight));
        var cfg = d.daynight || d;
        cfg.mode = segGet($("picNightSeg"), "auto");
        cfg.threshold = parseInt($("picThreshold").value, 10);
        cfg.dusk2dawn = $("picDusk").checked;
        await api("/x/json-config-daynight.cgi", { method: "POST", body: d });
        msgs.push("day/night");
      }
      if (store.gpio) {
        var g = JSON.parse(JSON.stringify(store.gpio));
        var gc = g.gpio || g;
        gc.ir_brightness = parseInt($("picIr").value, 10);
        gc.ir_led = $("picIrBand").value !== "off";
        gc.status_led = $("picStatusLed").value;
        await api("/x/json-config-gpio.cgi", { method: "POST", body: g });
        msgs.push("GPIO");
      }
      var band = $("picIrBand").value;
      if (band !== "off") {
        try {
          await api("/x/json-prudynt.cgi", { method: "POST", body: { privacy: { enabled: $("picPrivacy").checked } } });
          await api("/x/json-config-save.cgi", { method: "POST", body: {} });
          msgs.push("privacy");
        } catch (e) { /* streamer absent */ }
      } else {
        try {
          await api("/x/json-prudynt.cgi", { method: "POST", body: { privacy: { enabled: $("picPrivacy").checked } } });
          await api("/x/json-config-save.cgi", { method: "POST", body: {} });
          msgs.push("privacy");
        } catch (e) { /* streamer absent */ }
      }
      return msgs.length ? "Saved " + msgs.join(", ") + "." : "No picture backend available in this build.";
    },
  };

  loaders.audio = {
    load: async function () {
      try {
        var d = await api("/x/json-send2.cgi");
        store.send2 = d;
        if (d.speaker) {
          if (d.speaker.volume != null) $("audioSpeaker").value = Number(d.speaker.volume);
          if (d.speaker.microphone_volume != null) $("audioMic").value = Number(d.speaker.microphone_volume);
        }
      } catch (e) { markUnavailable("picNote", "Audio config"); }
    },
    save: async function () {
      if (!store.send2) throw new Error("Audio config endpoint not available.");
      var d = JSON.parse(JSON.stringify(store.send2));
      d.speaker = d.speaker || {};
      d.speaker.volume = parseInt($("audioSpeaker").value, 10);
      d.speaker.microphone_volume = parseInt($("audioMic").value, 10);
      await api("/x/json-send2.cgi", { method: "POST", body: d });
      return "Audio settings saved.";
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
          var o = document.createElement("option");
          o.value = t.tz_name; o.textContent = t.tz_name + " (current)";
          $("accountTz").appendChild(o); $("accountTz").value = t.tz_name;
        }
        $("accountNtp").value = t.ntp_server_0 || "";
      } catch (e) { markUnavailable("picNote", "Time config"); }
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
      var keys = [["fwVersion", "release"], ["fwBuild", "status"], ["fwKernel", "dmesg"]];
      for (var i = 0; i < keys.length; i++) {
        try {
          var d = await api("/x/info.cgi?" + keys[i][1]);
          var raw = (d && (d.output_base64 || d.output || d.data)) || "";
          var text = raw;
          try { text = atob(raw); } catch (e) { /* not base64 */ }
          if (typeof text === "string") $(keys[i][0]).textContent = text.trim().split("\n")[0].slice(0, 120) || "—";
        } catch (e) { $(keys[i][0]).textContent = "unavailable"; }
      }
    },
  };

  loaders.storage = {
    load: async function () {
      try {
        var d = await api("/x/tool-sdcard.cgi");
        var card = d.card || d.device || d;
        $("sdCard").textContent = card.model || card.name || card.device || "detected";
        $("sdCapacity").textContent = card.size || card.capacity || (d.total ? d.total + " KB" : "—");
        $("sdMount").textContent = card.mountpoint || d.mountpoint || "/mnt/mmcblk0p1";
        $("sdStatus").textContent = d.mounted == null ? "see tools" : (bool(d.mounted) ? "Mounted" : "Not mounted");
      } catch (e) {
        $("sdCard").textContent = "No SD card detected";
        say("sdStatus", "SD card tool unavailable in this build.", true);
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
