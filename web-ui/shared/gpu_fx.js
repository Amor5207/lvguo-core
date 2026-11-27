/* 绿果 PC 桌面端两 Pass WebGL2 GPU 画质增强与视频补帧渲染引擎。 */
(function () {
  'use strict';
  var LV = (window.LV = window.LV || {});

  var VS_FBO = [
    '#version 300 es',
    'precision highp float;',
    'const vec2 POS[4] = vec2[4](vec2(-1.0,-1.0), vec2(1.0,-1.0), vec2(-1.0,1.0), vec2(1.0,1.0));',
    'out vec2 vUv;',
    'void main() {',
    '  vec2 p = POS[gl_VertexID];',
    '  vUv = p * 0.5 + 0.5;',
    '  gl_Position = vec4(p, 0.0, 1.0);',
    '}'
  ].join('\n');

  var VS_SCREEN = [
    '#version 300 es',
    'precision highp float;',
    'const vec2 POS[4] = vec2[4](vec2(-1.0,-1.0), vec2(1.0,-1.0), vec2(-1.0,1.0), vec2(1.0,1.0));',
    'out vec2 vUv;',
    'void main() {',
    '  vec2 p = POS[gl_VertexID];',
    '  vUv = vec2(p.x * 0.5 + 0.5, 0.5 - p.y * 0.5);',
    '  gl_Position = vec4(p, 0.0, 1.0);',
    '}'
  ].join('\n');

  // Pass 1：源分辨率两级光流运动补偿插帧
  var FS_INTERP = [
    '#version 300 es',
    'precision highp float;',
    'in vec2 vUv;',
    'out vec4 fragColor;',
    'uniform sampler2D uPrevTex;',
    'uniform sampler2D uCurrTex;',
    'uniform vec2 uTexel;',
    'uniform float uAlpha;',
    '',
    'float luma(vec3 c) { return dot(c, vec3(0.299, 0.587, 0.114)); }',
    '',
    'vec2 gradFlow(vec2 uvA, vec2 uvB, float radiusPx) {',
    '  vec2 d = uTexel * radiusPx;',
    '  float pL = luma(texture(uPrevTex, uvA - vec2(d.x, 0.0)).rgb);',
    '  float pR = luma(texture(uPrevTex, uvA + vec2(d.x, 0.0)).rgb);',
    '  float pU = luma(texture(uPrevTex, uvA - vec2(0.0, d.y)).rgb);',
    '  float pD = luma(texture(uPrevTex, uvA + vec2(0.0, d.y)).rgb);',
    '  float cL = luma(texture(uCurrTex, uvB - vec2(d.x, 0.0)).rgb);',
    '  float cR = luma(texture(uCurrTex, uvB + vec2(d.x, 0.0)).rgb);',
    '  float cU = luma(texture(uCurrTex, uvB - vec2(0.0, d.y)).rgb);',
    '  float cD = luma(texture(uCurrTex, uvB + vec2(0.0, d.y)).rgb);',
    '  float gx = ((pR - pL) + (cR - cL)) * 0.5;',
    '  float gy = ((pD - pU) + (cD - cU)) * 0.5;',
    '  float gt = luma(texture(uCurrTex, uvB).rgb) - luma(texture(uPrevTex, uvA).rgb);',
    '  float denom = gx * gx + gy * gy + 0.0045;',
    '  return clamp(-vec2(gx, gy) * (gt / denom), vec2(-1.8), vec2(1.8)) * (uTexel * radiusPx * 2.2);',
    '}',
    '',
    'void main() {',
    '  vec3 cPrev = texture(uPrevTex, vUv).rgb;',
    '  vec3 cCurr = texture(uCurrTex, vUv).rgb;',
    '  if (uAlpha >= 0.992) { fragColor = vec4(cCurr, 1.0); return; }',
    '  if (uAlpha <= 0.008) { fragColor = vec4(cPrev, 1.0); return; }',
    '  float sceneDiff = dot(abs(cCurr - cPrev), vec3(0.3333));',
    '  if (sceneDiff > 0.30) { fragColor = vec4(uAlpha < 0.5 ? cPrev : cCurr, 1.0); return; }',
    '  vec2 coarse = gradFlow(vUv, vUv, 7.0);',
    '  vec2 uvPrevCoarse = clamp(vUv - coarse * uAlpha, vec2(0.0), vec2(1.0));',
    '  vec2 uvCurrCoarse = clamp(vUv + coarse * (1.0 - uAlpha), vec2(0.0), vec2(1.0));',
    '  vec2 fine = gradFlow(uvPrevCoarse, uvCurrCoarse, 2.0);',
    '  vec2 flow = clamp(coarse + fine, -uTexel * 22.0, uTexel * 22.0);',
    '  vec3 wPrev = texture(uPrevTex, clamp(vUv - flow * uAlpha, vec2(0.0), vec2(1.0))).rgb;',
    '  vec3 wCurr = texture(uCurrTex, clamp(vUv + flow * (1.0 - uAlpha), vec2(0.0), vec2(1.0))).rgb;',
    '  float occ = smoothstep(0.025, 0.14, dot(abs(wPrev - wCurr), vec3(0.3333)));',
    '  vec3 interp = mix(wPrev, wCurr, uAlpha);',
    '  vec3 linearBlend = mix(cPrev, cCurr, uAlpha);',
    '  fragColor = vec4(mix(interp, linearBlend, occ * 0.65), 1.0);',
    '}'
  ].join('\n');

  // Pass 2：高倍率超分 + 色彩调节 + 分屏对比
  var FS_ENHANCE = [
    '#version 300 es',
    'precision highp float;',
    'in vec2 vUv;',
    'out vec4 fragColor;',
    'uniform sampler2D uRawTex;',
    'uniform sampler2D uFrameTex;',
    'uniform vec2 uTexel;',
    'uniform int uSrMode;',
    'uniform float uSplit;',
    'uniform vec3 uBCS;',
    '',
    'float luma(vec3 c) { return dot(c, vec3(0.299, 0.587, 0.114)); }',
    '',
    'vec3 sampleSr() {',
    '  vec3 c = texture(uFrameTex, vUv).rgb;',
    '  if (uSrMode == 0) return c;',
    '  vec2 t1 = uTexel;',
    '  vec2 t2 = uTexel * 1.85;',
    '  vec3 n  = texture(uFrameTex, vUv + vec2(0.0, -t1.y)).rgb;',
    '  vec3 s  = texture(uFrameTex, vUv + vec2(0.0,  t1.y)).rgb;',
    '  vec3 w  = texture(uFrameTex, vUv + vec2(-t1.x, 0.0)).rgb;',
    '  vec3 e  = texture(uFrameTex, vUv + vec2( t1.x, 0.0)).rgb;',
    '  vec3 nw = texture(uFrameTex, vUv + vec2(-t1.x, -t1.y)).rgb;',
    '  vec3 ne = texture(uFrameTex, vUv + vec2( t1.x, -t1.y)).rgb;',
    '  vec3 sw = texture(uFrameTex, vUv + vec2(-t1.x,  t1.y)).rgb;',
    '  vec3 se = texture(uFrameTex, vUv + vec2( t1.x,  t1.y)).rgb;',
    '  vec3 mn = min(min(min(n, s), min(w, e)), c);',
    '  vec3 mx = max(max(max(n, s), max(w, e)), c);',
    '  float lRange = luma(mx - mn);',
    '  vec3 softPad = vec3(lRange * 0.35 + 0.025);',
    '  if (uSrMode == 1) {',
    '    vec3 avg4 = 0.25 * (n + s + w + e);',
    '    vec3 n2 = texture(uFrameTex, vUv + vec2(0.0, -t2.y)).rgb;',
    '    vec3 s2 = texture(uFrameTex, vUv + vec2(0.0,  t2.y)).rgb;',
    '    vec3 w2 = texture(uFrameTex, vUv + vec2(-t2.x, 0.0)).rgb;',
    '    vec3 e2 = texture(uFrameTex, vUv + vec2( t2.x, 0.0)).rgb;',
    '    vec3 avgWide = 0.15 * (n + s + w + e) + 0.10 * (n2 + s2 + w2 + e2);',
    '    vec3 hi = 0.65 * (c - avg4) + 0.35 * (c - avgWide);',
    '    float gain = mix(1.35, 0.70, clamp(lRange * 1.8, 0.0, 1.0));',
    '    return clamp(c + hi * gain, mn - softPad, mx + softPad);',
    '  }',
    '  float edgeH = abs(luma(w) - luma(e));',
    '  float edgeV = abs(luma(n) - luma(s));',
    '  vec3 dirAvg = edgeH > edgeV ? 0.5 * (n + s) : 0.5 * (w + e);',
    '  vec3 blur9 = 0.16 * (n + s + w + e) + 0.09 * (nw + ne + sw + se);',
    '  if (uSrMode == 2) {',
    '    float edgeW = clamp((edgeH + edgeV) * 2.2, 0.0, 1.0);',
    '    vec3 eau = mix(c, dirAvg, 0.22 * edgeW);',
    '    vec3 detail = eau + (c - blur9) * 1.55;',
    '    detail = clamp(detail, mn - softPad * 1.35, mx + softPad * 1.35);',
    '    detail = clamp((detail - 0.5) * 1.07 + 0.5, 0.0, 1.0);',
    '    return mix(vec3(luma(detail)), detail, 1.06);',
    '  }',
    '  vec3 gx = (ne + 2.0 * e + se) - (nw + 2.0 * w + sw);',
    '  vec3 gy = (sw + 2.0 * s + se) - (nw + 2.0 * n + ne);',
    '  float grad = clamp(length(vec2(luma(gx), luma(gy))) * 1.75, 0.0, 1.0);',
    '  vec3 sharp = c + (c - blur9) * mix(1.35, 2.05, grad);',
    '  sharp = clamp(sharp, mn - softPad * 1.5, mx + softPad * 1.5);',
    '  sharp = clamp((sharp - 0.5) * 1.12 + 0.5, 0.0, 1.0);',
    '  return mix(vec3(luma(sharp)), sharp, 1.08);',
    '}',
    '',
    'void main() {',
    '  if (uSplit > 0.5) {',
    '    if (abs(vUv.x - 0.5) < 0.0022) { fragColor = vec4(0.20, 0.86, 0.58, 1.0); return; }',
    '    if (vUv.x < 0.5) { fragColor = vec4(texture(uRawTex, vUv).rgb, 1.0); return; }',
    '  }',
    '  vec3 c = sampleSr();',
    '  c *= uBCS.x;',
    '  c = (c - 0.5) * uBCS.y + 0.5;',
    '  float g = luma(c);',
    '  c = mix(vec3(g), c, uBCS.z);',
    '  fragColor = vec4(clamp(c, 0.0, 1.0), 1.0);',
    '}'
  ].join('\n');

  function compileShader(gl, type, src) {
    var s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
      gl.deleteShader(s);
      return null;
    }
    return s;
  }

  function linkProg(gl, vsSrc, fsSrc) {
    var vs = compileShader(gl, gl.VERTEX_SHADER, vsSrc);
    var fs = compileShader(gl, gl.FRAGMENT_SHADER, fsSrc);
    if (!vs || !fs) return null;
    var prog = gl.createProgram();
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.linkProgram(prog);
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      gl.deleteProgram(prog);
      return null;
    }
    return prog;
  }

  function makeTex(gl) {
    var t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    return t;
  }

  function GpuVideoFX(stage) {
    this.stage = stage;
    this.video = null;
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'gpu-fx';
    this.canvas.setAttribute('aria-hidden', 'true');
    this.canvas.hidden = true;
    stage.appendChild(this.canvas);

    this.gl = null;
    this.vao = null;
    this.progInterp = null;
    this.progEnhance = null;
    this.uInterp = null;
    this.uEnhance = null;
    this.prevTex = null;
    this.currTex = null;
    this.fbo = null;
    this.fboTex = null;
    this.fboW = 0;
    this.fboH = 0;

    this.raf = 0;
    this.vfc = 0;
    this.hasPrev = false;
    this.lastMediaTime = -1;
    this.prevPerfMs = 0;
    this.currPerfMs = 0;
    this.frameIntervalMs = 33.33;

    this.opts = {
      superRes: 'off',
      frameInterp: 'off',
      splitCompare: false,
      brightness: 1,
      contrast: 1,
      saturation: 1
    };
  }

  GpuVideoFX.prototype._initGL = function () {
    if (this.gl) return true;
    var gl = this.canvas.getContext('webgl2', {
      alpha: false,
      antialias: false,
      depth: false,
      stencil: false,
      powerPreference: 'high-performance',
      preserveDrawingBuffer: true
    });
    if (!gl) return false;
    var p1 = linkProg(gl, VS_FBO, FS_INTERP);
    var p2 = linkProg(gl, VS_SCREEN, FS_ENHANCE);
    if (!p1 || !p2) return false;
    this.gl = gl;
    this.vao = gl.createVertexArray();
    this.progInterp = p1;
    this.progEnhance = p2;
    this.prevTex = makeTex(gl);
    this.currTex = makeTex(gl);
    this.fboTex = makeTex(gl);
    this.fbo = gl.createFramebuffer();
    this.uInterp = {
      prevTex: gl.getUniformLocation(p1, 'uPrevTex'),
      currTex: gl.getUniformLocation(p1, 'uCurrTex'),
      texel: gl.getUniformLocation(p1, 'uTexel'),
      alpha: gl.getUniformLocation(p1, 'uAlpha')
    };
    this.uEnhance = {
      rawTex: gl.getUniformLocation(p2, 'uRawTex'),
      frameTex: gl.getUniformLocation(p2, 'uFrameTex'),
      texel: gl.getUniformLocation(p2, 'uTexel'),
      srMode: gl.getUniformLocation(p2, 'uSrMode'),
      split: gl.getUniformLocation(p2, 'uSplit'),
      bcs: gl.getUniformLocation(p2, 'uBCS')
    };
    return true;
  };

  GpuVideoFX.prototype._ensureFboSize = function (w, h) {
    var gl = this.gl;
    if (!gl || (this.fboW === w && this.fboH === h)) return;
    this.fboW = w;
    this.fboH = h;
    gl.bindTexture(gl.TEXTURE_2D, this.fboTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.fboTex, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  };

  GpuVideoFX.prototype.isActive = function () {
    var o = this.opts;
    return o.superRes !== 'off' ||
      o.frameInterp !== 'off' ||
      !!o.splitCompare ||
      Math.abs((o.brightness || 1) - 1) > 0.01 ||
      Math.abs((o.contrast || 1) - 1) > 0.01 ||
      Math.abs((o.saturation || 1) - 1) > 0.01;
  };

  GpuVideoFX.prototype.configure = function (next) {
    this.opts = Object.assign({}, this.opts, next || {});
    this._syncLoop();
    if (this.isActive() && this.currPerfMs > 0) this._render();
  };

  GpuVideoFX.prototype.attach = function (video) {
    if (this.video === video) {
      this._syncLoop();
      return;
    }
    this._stopLoops();
    this.video = video;
    this.hasPrev = false;
    this.lastMediaTime = -1;
    this.prevPerfMs = 0;
    this.currPerfMs = 0;
    this._syncLoop();
  };

  GpuVideoFX.prototype._stopLoops = function () {
    if (this.raf) { cancelAnimationFrame(this.raf); this.raf = 0; }
    if (this.vfc && this.video && this.video.cancelVideoFrameCallback) {
      try { this.video.cancelVideoFrameCallback(this.vfc); } catch (e) {}
    }
    this.vfc = 0;
  };

  GpuVideoFX.prototype._uploadFrame = function (mediaTime) {
    var gl = this.gl, v = this.video;
    if (!gl || !v || v.readyState < 2 || !v.videoWidth || !v.videoHeight) return;
    if (this.currPerfMs > 0) {
      var swap = this.prevTex;
      this.prevTex = this.currTex;
      this.currTex = swap;
      this.hasPrev = true;
    }
    try {
      gl.bindTexture(gl.TEXTURE_2D, this.currTex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, v);
      var now = performance.now();
      if (this.currPerfMs > 0 && now > this.currPerfMs) {
        var dt = now - this.currPerfMs;
        if (dt >= 6 && dt <= 90) {
          this.frameIntervalMs = this.frameIntervalMs * 0.75 + dt * 0.25;
        }
      }
      this.prevPerfMs = this.currPerfMs;
      this.currPerfMs = now;
      this.lastMediaTime = mediaTime;
    } catch (e) {}
  };

  // 纯视频驱动：非补帧模式下仅在解码出新视频帧时渲染一次，不空耗刷新率
  GpuVideoFX.prototype._startFrameWatch = function () {
    var self = this, v = this.video;
    if (!v || !v.requestVideoFrameCallback || this.vfc) return;
    var step = function (now, meta) {
      self.vfc = 0;
      if (self.video !== v || !self.isActive()) return;
      var mt = meta && meta.mediaTime != null ? meta.mediaTime : (v.currentTime || 0);
      if (mt !== self.lastMediaTime) {
        self._uploadFrame(mt);
        if (self.opts.frameInterp !== 'smooth') self._render();
      }
      self.vfc = v.requestVideoFrameCallback(step);
    };
    this.vfc = v.requestVideoFrameCallback(step);
  };

  GpuVideoFX.prototype._render = function () {
    var gl = this.gl, v = this.video, o = this.opts;
    if (!gl || !v || v.readyState < 2 || !v.videoWidth || !v.videoHeight) return;

    if (!v.requestVideoFrameCallback) {
      var ct = v.currentTime || 0;
      if (ct !== this.lastMediaTime) this._uploadFrame(ct);
    } else if (this.currPerfMs === 0) {
      this._uploadFrame(v.currentTime || 0);
    }
    if (this.currPerfMs === 0) return;

    var vw = v.videoWidth, vh = v.videoHeight;
    var scale = o.superRes === 'anime4k' ? 2.0 : (o.superRes === 'fsr' ? 1.65 : (o.superRes === 'cas' ? 1.25 : 1.0));
    var targetW = Math.min(2880, Math.round(vw * scale));
    var targetH = Math.round(vh * (targetW / vw));
    if (this.canvas.width !== targetW || this.canvas.height !== targetH) {
      this.canvas.width = targetW;
      this.canvas.height = targetH;
    }
    this.canvas.style.transform = v.style.transform || '';
    this.canvas.style.objectFit = v.style.objectFit || '';
    this.canvas.className = 'gpu-fx' + (v.classList.contains('pending') ? ' pending' : '');

    var now = performance.now();
    var interpOn = (o.frameInterp === 'smooth' && this.hasPrev && !v.paused && this.frameIntervalMs > 0);
    var frameTex = this.currTex;

    gl.bindVertexArray(this.vao);
    if (interpOn) {
      this._ensureFboSize(vw, vh);
      var alpha = Math.max(0.0, Math.min(1.0, (now - this.currPerfMs) / this.frameIntervalMs));
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
      gl.viewport(0, 0, vw, vh);
      gl.useProgram(this.progInterp);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.prevTex);
      gl.uniform1i(this.uInterp.prevTex, 0);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, this.currTex);
      gl.uniform1i(this.uInterp.currTex, 1);
      gl.uniform2f(this.uInterp.texel, 1.0 / vw, 1.0 / vh);
      gl.uniform1f(this.uInterp.alpha, alpha);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      frameTex = this.fboTex;
    }

    var modeInt = o.superRes === 'cas' ? 1 : o.superRes === 'fsr' ? 2 : o.superRes === 'anime4k' ? 3 : 0;
    gl.viewport(0, 0, targetW, targetH);
    gl.useProgram(this.progEnhance);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.currTex);
    gl.uniform1i(this.uEnhance.rawTex, 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, frameTex);
    gl.uniform1i(this.uEnhance.frameTex, 1);
    gl.uniform2f(this.uEnhance.texel, 1.0 / vw, 1.0 / vh);
    gl.uniform1i(this.uEnhance.srMode, modeInt);
    gl.uniform1f(this.uEnhance.split, o.splitCompare ? 1.0 : 0.0);
    gl.uniform3f(this.uEnhance.bcs, o.brightness || 1, o.contrast || 1, o.saturation || 1);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  };

  GpuVideoFX.prototype._syncLoop = function () {
    var self = this;
    var on = this.isActive() && !!this.video && this._initGL();
    this.canvas.hidden = !on;
    if (!on) {
      this._stopLoops();
      return;
    }
    this._startFrameWatch();
    // 仅开启补帧（或缺少 requestVideoFrameCallback 的环境）时启用逐帧循环
    var needRaf = this.opts.frameInterp === 'smooth' || !this.video.requestVideoFrameCallback;
    if (!needRaf) {
      if (this.raf) { cancelAnimationFrame(this.raf); this.raf = 0; }
      return;
    }
    if (!this.raf) {
      var loop = function () {
        if (!self.isActive() || !self.video) { self.raf = 0; return; }
        if (self.opts.frameInterp !== 'smooth' && self.video.requestVideoFrameCallback) { self.raf = 0; return; }
        self._render();
        self.raf = requestAnimationFrame(loop);
      };
      this.raf = requestAnimationFrame(loop);
    }
  };

  GpuVideoFX.prototype.captureFrame = function () {
    if (!this.video || !this.video.videoWidth) return null;
    if (!this.canvas.hidden && this.gl && this.currPerfMs > 0) {
      try {
        this._render();
        return this.canvas.toDataURL('image/png');
      } catch (e) {}
    }
    var tmp = document.createElement('canvas');
    tmp.width = this.video.videoWidth;
    tmp.height = this.video.videoHeight;
    var ctx = tmp.getContext('2d');
    if (!ctx) return null;
    ctx.drawImage(this.video, 0, 0, tmp.width, tmp.height);
    return tmp.toDataURL('image/png');
  };

  GpuVideoFX.prototype.destroy = function () {
    this._stopLoops();
    if (this.gl) {
      try {
        if (this.prevTex) this.gl.deleteTexture(this.prevTex);
        if (this.currTex) this.gl.deleteTexture(this.currTex);
        if (this.fboTex) this.gl.deleteTexture(this.fboTex);
        if (this.fbo) this.gl.deleteFramebuffer(this.fbo);
        if (this.progInterp) this.gl.deleteProgram(this.progInterp);
        if (this.progEnhance) this.gl.deleteProgram(this.progEnhance);
        if (this.vao) this.gl.deleteVertexArray(this.vao);
      } catch (e) {}
    }
    this.canvas.remove();
  };

  LV.GpuVideoFX = GpuVideoFX;
})();
