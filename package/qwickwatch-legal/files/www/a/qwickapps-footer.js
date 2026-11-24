/*
 * Persistent QwickApps branding link for the QwickWatch Edge OS WebUI.
 *
 * Loaded on every page via the qwickwatch-legal plugin manifest. The core
 * footer.js builds its footer on DOMContentLoaded, so this script waits for
 * that footer to appear before adding the link. Pages without the generated
 * footer (for example the standalone login page) still get a small,
 * unobtrusive link so the branding is present everywhere.
 */
(function () {
  "use strict";

  function buildLink() {
    var wrap = document.createElement("div");
    wrap.className = "small qwickapps-footer-link";

    var link = document.createElement("a");
    link.href = "https://qwickapps.com";
    link.textContent = "qwickapps.com";
    link.target = "_blank";
    link.rel = "noreferrer noopener";

    wrap.appendChild(link);
    return wrap;
  }

  function appendToFooter(footer) {
    if (footer.querySelector(".qwickapps-footer-link")) return;

    var row = footer.querySelector(".row");
    var target = row ? row.lastElementChild : footer;
    if (!target) return;

    target.appendChild(buildLink());
  }

  function appendStandalone() {
    if (document.querySelector(".qwickapps-footer-link")) return;

    var wrap = buildLink();
    wrap.style.position = "fixed";
    wrap.style.bottom = "0.25rem";
    wrap.style.right = "0.5rem";
    wrap.style.opacity = "0.7";
    wrap.style.zIndex = "1030";
    document.body.appendChild(wrap);
  }

  function start() {
    var attempts = 0;

    function attempt() {
      var footer = document.querySelector('footer[data-generated-footer="true"]');
      if (footer) {
        appendToFooter(footer);
        return;
      }

      // footer.js registers its DOMContentLoaded handler before this script's
      // (core scripts sit in <body>, plugin scripts are injected into <head>),
      // so give it a few frames to mount before falling back.
      attempts += 1;
      if (attempts < 12) {
        window.setTimeout(attempt, 50);
      } else {
        appendStandalone();
      }
    }

    attempt();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start, { once: true });
  } else {
    start();
  }
})();
