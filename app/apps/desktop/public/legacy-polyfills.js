/*
 * Baalda: features newer JavaScript code expects, for older Macs.
 *
 * macOS 10.15 and 11 can run a Safari (and so a WKWebView) older than 15.4.
 * Some libraries the app loads at startup call these at load time; without
 * them the whole app stops before it draws anything and the window stays
 * empty (reported on an Intel Mac as "just a black screen"). This file is a
 * classic script in index.html's <head>, so it runs before any module.
 *
 * Plain ES5 on purpose: it must parse on the oldest webview we support.
 * Each one is added only when missing, never replacing a built-in.
 */
(function () {
  "use strict";
  // What this computer was missing, for the startup log (main.tsx).
  var filled = [];
  try { window.__baaldaPolyfills = filled; } catch (e) {}
  function define(target, name, value) {
    if (!target || typeof target[name] === "function") return;
    try {
      Object.defineProperty(target, name, { value: value, writable: true, configurable: true, enumerable: false });
      filled.push(name);
    } catch (e) {}
  }
  function toIndex(len, n) {
    n = Math.trunc ? Math.trunc(Number(n)) || 0 : (Number(n) | 0);
    return n < 0 ? len + n : n;
  }
  function at(n) {
    var len = this.length >>> 0;
    var i = toIndex(len, n);
    if (i < 0 || i >= len) return undefined;
    return typeof this === "string" || this instanceof String ? String(this).charAt(i) : this[i];
  }
  function findLast(fn, thisArg) {
    for (var i = (this.length >>> 0) - 1; i >= 0; i--) if (fn.call(thisArg, this[i], i, this)) return this[i];
    return undefined;
  }
  function findLastIndex(fn, thisArg) {
    for (var i = (this.length >>> 0) - 1; i >= 0; i--) if (fn.call(thisArg, this[i], i, this)) return i;
    return -1;
  }

  define(Object, "hasOwn", function hasOwn(obj, key) {
    if (obj === null || obj === undefined) throw new TypeError("Cannot convert undefined or null to object");
    return Object.prototype.hasOwnProperty.call(Object(obj), key);
  });

  var typed = typeof Int8Array === "function" ? Object.getPrototypeOf(Int8Array.prototype) : null;
  var targets = [Array.prototype, typed];
  for (var t = 0; t < targets.length; t++) {
    define(targets[t], "at", at);
    define(targets[t], "findLast", findLast);
    define(targets[t], "findLastIndex", findLastIndex);
  }
  define(String.prototype, "at", at);

  define(String.prototype, "replaceAll", function replaceAll(search, replacement) {
    if (search instanceof RegExp) {
      if (search.flags.indexOf("g") < 0) throw new TypeError("replaceAll must be called with a global RegExp");
      return String(this).replace(search, replacement);
    }
    var escaped = String(search).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return String(this).replace(new RegExp(escaped, "g"), replacement);
  });

  if (typeof globalThis !== "undefined" && typeof globalThis.structuredClone !== "function") {
    var clone = function (value, seen) {
      if (value === null || typeof value !== "object") {
        if (typeof value === "function" || typeof value === "symbol") throw new Error("DataCloneError");
        return value;
      }
      if (seen.has(value)) return seen.get(value);
      var out;
      if (value instanceof Date) out = new Date(value.getTime());
      else if (value instanceof RegExp) out = new RegExp(value.source, value.flags);
      else if (typeof Map === "function" && value instanceof Map) {
        out = new Map(); seen.set(value, out);
        value.forEach(function (v, k) { out.set(clone(k, seen), clone(v, seen)); });
        return out;
      } else if (typeof Set === "function" && value instanceof Set) {
        out = new Set(); seen.set(value, out);
        value.forEach(function (v) { out.add(clone(v, seen)); });
        return out;
      } else if (ArrayBuffer.isView(value)) out = new value.constructor(value);
      else if (value instanceof ArrayBuffer) out = value.slice(0);
      else if (Array.isArray(value)) {
        out = []; seen.set(value, out);
        for (var i = 0; i < value.length; i++) out[i] = clone(value[i], seen);
        return out;
      } else {
        out = {}; seen.set(value, out);
        var keys = Object.keys(value);
        for (var k = 0; k < keys.length; k++) out[keys[k]] = clone(value[keys[k]], seen);
        return out;
      }
      seen.set(value, out);
      return out;
    };
    globalThis.structuredClone = function structuredClone(value) { return clone(value, new Map()); };
    filled.push("structuredClone");
  }
})();
