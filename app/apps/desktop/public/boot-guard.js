/*
 * Baalda: if the app fails to start, say so instead of showing an empty window.
 *
 * The window is revealed by the app on its first render, or by the native side
 * after 1.5 s whatever happens (src-tauri/src/lib.rs). When the app's code fails
 * before React draws anything (an old webview missing something the code needs,
 * a broken update), that reveal used to show an empty, theme-coloured window:
 * "just a black screen". This classic script runs before any module, records
 * the first startup error, and if #root is still empty after a few seconds it
 * writes a short message there. Plain ES5 on purpose.
 */
(function () {
  "use strict";
  var firstError = null;
  window.__baaldaBootGuard = true;
  function remember(message) {
    if (firstError === null && message) firstError = String(message).slice(0, 300);
  }
  window.addEventListener("error", function (e) {
    remember(e && (e.message || (e.error && e.error.message)) || "A script failed to load");
  }, true);
  window.addEventListener("unhandledrejection", function (e) {
    var r = e && e.reason;
    remember(r && r.message ? r.message : r);
  });

  function show() {
    var root = document.getElementById("root");
    if (!root || root.childNodes.length > 0) return;
    if (window.__baaldaMounted) return;
    var dark = document.documentElement.getAttribute("data-theme") === "dark";
    var mac = /Mac/.test(navigator.platform || "") || /Mac OS X/.test(navigator.userAgent || "");
    var fg = dark ? "#ececec" : "#1f1f1f";
    var muted = dark ? "#a8a8a8" : "#5c5c5c";
    var box = document.createElement("div");
    box.setAttribute("role", "alert");
    box.setAttribute("data-boot-failure", "");
    box.style.cssText = "max-width:440px;margin:18vh auto 0;padding:0 24px;font:14px/1.5 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:" + fg + ";";
    var title = document.createElement("h1");
    title.style.cssText = "font-size:18px;font-weight:600;margin:0 0 8px;";
    title.textContent = "Baalda couldn't start";
    var body = document.createElement("p");
    body.style.cssText = "margin:0 0 12px;";
    body.textContent = mac
      ? "This usually means this Mac needs an update. Open System Preferences, then Software Update, install every update offered (Safari too), and open Baalda again."
      : "Quit Baalda and open it again. If this keeps happening, install the latest version from baalda.com.";
    box.appendChild(title);
    box.appendChild(body);
    if (firstError) {
      var detail = document.createElement("p");
      detail.style.cssText = "margin:0;font:12px/1.4 ui-monospace,Menlo,Consolas,monospace;color:" + muted + ";word-break:break-word;";
      detail.textContent = "Details: " + firstError;
      box.appendChild(detail);
    }
    root.appendChild(box);
  }
  // Sooner when something already failed; later otherwise, so a slow first
  // start on an old computer is never interrupted.
  window.setTimeout(function () { if (firstError !== null) show(); }, 6000);
  window.setTimeout(show, 15000);
})();
