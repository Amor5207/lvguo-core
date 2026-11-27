/* 旧版浏览器与兼容运行时垫片（Chrome 49 / Edge / 老旧 Windows 兼容）
 * 仅在原生 API 缺失时注入轻量回退，零侵入、零框架依赖。 */
(function () {
  'use strict';
  if (typeof Object.assign !== 'function') {
    Object.assign = function (target) {
      if (target == null) return target;
      var to = Object(target);
      for (var i = 1; i < arguments.length; i++) {
        var next = arguments[i];
        if (next != null) {
          for (var k in next) {
            if (Object.prototype.hasOwnProperty.call(next, k)) to[k] = next[k];
          }
        }
      }
      return to;
    };
  }
  if (!Array.from) {
    Array.from = function (arr) { return Array.prototype.slice.call(arr); };
  }
  if (typeof Element !== 'undefined' && !Element.prototype.matches) {
    Element.prototype.matches = Element.prototype.msMatchesSelector || Element.prototype.webkitMatchesSelector;
  }
  if (typeof Element !== 'undefined' && !Element.prototype.closest) {
    Element.prototype.closest = function (s) {
      var el = this;
      while (el && el.nodeType === 1) {
        if (el.matches(s)) return el;
        el = el.parentElement || el.parentNode;
      }
      return null;
    };
  }
  if (typeof Element !== 'undefined' && !Element.prototype.animate) {
    Element.prototype.animate = function () {
      var stub = { onfinish: null, play: function () {}, pause: function () {}, cancel: function () {} };
      setTimeout(function () { if (stub.onfinish) stub.onfinish(); }, 0);
      return stub;
    };
  }
  if (typeof String.prototype.padStart !== 'function') {
    String.prototype.padStart = function (len, fill) {
      var s = String(this), f = String(fill == null ? ' ' : fill);
      while (s.length < len) s = f + s;
      return s.slice(-len);
    };
  }
})();
