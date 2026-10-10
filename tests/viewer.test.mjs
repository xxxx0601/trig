import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { webcrypto } from "node:crypto";
import vm from "node:vm";

const cacheSource = readFileSync(new URL("../static/js/viewer-cache.js", import.meta.url), "utf8").replace(/^export /gm, "");
const viewerSource = readFileSync(new URL("../static/js/viewer.js", import.meta.url), "utf8").replace(/^import[\s\S]*?;\n/gm, "");

function harness(saved = new Map(), blockedStorage = false) {
  let timerId = 0;
  const timers = new Map();
  class Vector3 {
    constructor(x = 0, y = 0, z = 0) { this.values = [x, y, z]; }
    normalize() { return this; }
    fromArray(values) { this.values = [...values]; return this; }
    toArray() { return [...this.values]; }
  }
  class Box3 {
    constructor(min, max) { this.min = min; this.max = max; }
  }
  class BufferAttribute {
    constructor(array, itemSize) { this.array = array; this.itemSize = itemSize; }
  }
  const document = { hidden: false, querySelectorAll: () => [], addEventListener() {} };
  const window = {
    location: { href: "http://localhost:8000/" },
    setTimeout(callback, delay) { const id = ++timerId; timers.set(id, { callback, delay }); return id; },
    clearTimeout(id) { timers.delete(id); },
  };
  const context = vm.createContext({
    console, URL, crypto: webcrypto, Uint8Array, Float32Array, document, window,
    THREE: {
      Vector3, Box3, BufferAttribute,
      MathUtils: { degToRad: (value) => value * Math.PI / 180 },
      MeshStandardMaterial: class { constructor(options) { Object.assign(this, options); } },
      Color: class { setHSL(h, s, l) { Object.assign(this, { r: h, g: s, b: l }); return this; } },
    },
    GLTFLoader: class {},
    localStorage: {
      getItem(key) { if (blockedStorage) throw new Error("storage disabled"); return saved.get(key); },
      setItem(key, value) { if (blockedStorage) throw new Error("quota"); saved.set(key, value); },
    },
  });
  vm.runInContext(`${cacheSource}\n${viewerSource}\nglobalThis.testAPI = { RigViewer, fingerprintModel, readModelBounds, saveModelBounds, idleViewers, retainIdleViewer, viewerLoadQueue, processViewerLoadQueue };`, context);
  return { ...context.testAPI, context, timers, document, saved };
}

const h = harness();
const url = "http://localhost:8000/source/model1.glb";
const bytes = new Uint8Array([1, 2, 3]).buffer;
const fingerprint = await h.fingerprintModel(bytes);
assert.equal(fingerprint.length, 64);
const bounds = { min: [-1, 0, -2], max: [1, 4, 2] };
assert.equal(h.readModelBounds(url, fingerprint), null);
h.saveModelBounds(url, fingerprint, bounds);
const reloaded = harness(h.saved);
assert.deepEqual(JSON.parse(JSON.stringify(reloaded.readModelBounds(url, fingerprint))), bounds);
assert.equal(reloaded.readModelBounds(url, await h.fingerprintModel(new Uint8Array([1, 2, 4]).buffer)), null);
assert.equal(h.readModelBounds(url, null), null);
h.saveModelBounds("invalid", fingerprint, { min: [2, 0, 0], max: [1, 1, 1] });
assert.equal(h.readModelBounds("invalid", fingerprint), null);
for (let i = 0; i < 70; i++) h.saveModelBounds(`model-${i}`, fingerprint, bounds);
assert.equal(JSON.parse([...h.saved.values()][0]).length, 64);
assert.equal(h.readModelBounds("model-0", fingerprint), null);
const blocked = harness(new Map(), true);
blocked.saveModelBounds(url, fingerprint, bounds);
assert.ok(blocked.readModelBounds(url, fingerprint));
assert.equal(harness(new Map([["tailorrig:model-bounds:v1", "broken JSON"]])).readModelBounds(url, fingerprint), null);
console.log("PASS: persisted bounds survive reloads; changed models and invalid records miss; storage failures degrade safely; record count is bounded.");

const viewer = Object.create(reloaded.RigViewer.prototype);
Object.assign(viewer, { boundsCacheUrl: url, modelFingerprint: fingerprint });
viewer.calculateContentBounds = () => { throw new Error("cache hit must not sample animation"); };
assert.deepEqual(viewer.computeContentBounds().min.toArray(), bounds.min);
viewer.modelFingerprint = "updated";
let boundCalculations = 0;
viewer.calculateContentBounds = () => {
  boundCalculations++;
  return { min: { toArray: () => bounds.min }, max: { toArray: () => bounds.max } };
};
viewer.computeContentBounds();
viewer.computeContentBounds();
assert.equal(boundCalculations, 1);
console.log("PASS: cached models skip animation sampling; changed models calculate once and cache the new result.");

function geometry(attributes) {
  return {
    getAttribute: (name) => attributes[name],
    setAttribute(name, value) { attributes[name] = value; },
    clone: () => geometry({ ...attributes }),
  };
}
const channels = (values) => Object.fromEntries(["getX", "getY", "getZ", "getW"].map((name, channel) => [name, (index) => values[index][channel]]));
const displayGeometry = geometry({
  position: { count: 2 },
  skinIndex: channels([[0, 1, 0, 0], [1, 0, 0, 0]]),
  skinWeight: channels([[0.25, 0.75, 0, 0], [0.5, 0, 0, 0]]),
});
const weightsViewer = Object.create(h.RigViewer.prototype);
const record = {
  mesh: { isSkinnedMesh: true }, displayGeometry, weightGeometry: null, weightMaterial: null,
  boneColors: [{ r: 1, g: 0, b: 0 }, { r: 0, g: 1, b: 0 }],
};
weightsViewer.meshRecords = [record, { mesh: { isSkinnedMesh: false } }];
assert.equal(record.weightGeometry, null);
weightsViewer.applyWeightMaterials();
assert.deepEqual(Array.from(record.weightGeometry.getAttribute("color").array), [0.25, 0.75, 0, 0, 1, 0]);
const firstWeightGeometry = record.weightGeometry;
weightsViewer.restoreMeshMaterials();
weightsViewer.applyWeightMaterials();
assert.equal(record.weightGeometry, firstWeightGeometry);
assert.equal(record.mesh.geometry, firstWeightGeometry);
console.log("PASS: Weights produces normalized colors on first use and reuses the same geometry on subsequent switches.");

const lifecycle = Object.create(h.RigViewer.prototype);
const loopCalls = [];
Object.assign(lifecycle, {
  isVisible: true, isInitialized: true, renderer: { setAnimationLoop: (callback) => loopCalls.push(callback) },
  orbitControls: {}, renderFrame() {}, init() {},
});
lifecycle.updatePlayback();
assert.equal(loopCalls.at(-1), lifecycle.renderFrame);
lifecycle.setVisible(false);
assert.equal(loopCalls.at(-1), null);
assert.equal(h.timers.get(lifecycle.releaseTimer).delay, 10000);
lifecycle.setVisible(true);
assert.equal(h.idleViewers.has(lifecycle), false);
assert.equal(lifecycle.releaseTimer, null);
assert.equal(loopCalls.at(-1), lifecycle.renderFrame);
h.document.hidden = true;
lifecycle.updatePlayback();
assert.equal(loopCalls.at(-1), null);
assert.equal(lifecycle.orbitControls.enabled, false);
h.document.hidden = false;
lifecycle.updatePlayback();
assert.equal(loopCalls.at(-1), lifecycle.renderFrame);
assert.equal(lifecycle.lastFrameTime, null);

const idle = Array.from({ length: 4 }, () => ({
  isVisible: false, renderer: {}, destroyed: false,
  destroy() { this.destroyed = true; h.idleViewers.delete(this); h.context.window.clearTimeout(this.releaseTimer); },
}));
idle.forEach(h.retainIdleViewer);
assert.equal(h.idleViewers.size, 3);
assert.equal(idle[0].destroyed, true);
assert.equal(idle[3].destroyed, false);
h.timers.get(idle[3].releaseTimer).callback();
assert.equal(idle[3].destroyed, true);
console.log("PASS: offscreen and background viewers stop rendering immediately; return resumes; only three idle cards remain and expire after ten seconds.");

const prefetchViewer = Object.create(h.RigViewer.prototype);
Object.assign(prefetchViewer, { isVisible: false, isNearViewport: false, isInitialized: false, isLoading: false, isQueued: false });
let loadStarted = 0;
prefetchViewer.startLoading = async () => { loadStarted++; };
prefetchViewer.setNearViewport(true);
assert.equal(loadStarted, 1);
assert.equal(prefetchViewer.isVisible, false);
await new Promise((resolve) => setImmediate(resolve));
h.document.hidden = true;
prefetchViewer.init();
assert.equal(loadStarted, 1);
h.document.hidden = false;
h.processViewerLoadQueue();
assert.equal(loadStarted, 2);
console.log("PASS: prefetch can load without playing; background tabs defer queued loads until visible.");

const inactive = Object.create(h.RigViewer.prototype);
let inactiveLoads = 0;
Object.assign(inactive, {
  isEnabled: false, isVisible: false, isNearViewport: false,
  isInitialized: false, isLoading: false, isQueued: false,
  startLoading: async () => { inactiveLoads++; },
});
inactive.setNearViewport(true);
inactive.setVisible(true);
assert.equal(inactiveLoads, 0);
assert.equal(inactive.isVisible, false);
assert.equal(inactive.isNearViewport, false);
inactive.setEnabled(true);
inactive.setNearViewport(true);
assert.equal(inactiveLoads, 1);
await new Promise((resolve) => setImmediate(resolve));

lifecycle.isEnabled = true;
lifecycle.isVisible = true;
lifecycle.isQueued = true;
h.viewerLoadQueue.push(lifecycle);
lifecycle.setEnabled(false);
assert.equal(loopCalls.at(-1), null);
assert.equal(lifecycle.isNearViewport, false);
assert.equal(lifecycle.isQueued, false);
assert.equal(h.viewerLoadQueue.includes(lifecycle), false);
lifecycle.setVisible(true);
assert.equal(lifecycle.isVisible, false);
let canceledLoad = false;
inactive.isLoading = true;
inactive.destroy = () => { canceledLoad = true; };
inactive.setEnabled(false);
assert.equal(canceledLoad, true);
console.log("PASS: inactive character rows cannot load or play, including stale visibility callbacks; switching removes queued loads and cancels unfinished loads.");
